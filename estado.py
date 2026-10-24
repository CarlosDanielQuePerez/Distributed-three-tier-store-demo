#!/usr/bin/env python3
"""Panel de estado del sistema distribuido (se actualiza solo)."""
import json, os, subprocess, time, datetime

OUT_DIR = "/tmp/estado"
os.makedirs(OUT_DIR, exist_ok=True)
INIT = {"catalog-init", "mongo-init"}
GRUPOS = [
    ("Entrada (única puerta desde tu navegador)", ["presentation-entry"]),
    ("Capa de presentación", ["presentation-lb-master", "presentation-lb-backup",
        "presentation-keepalived-master", "presentation-keepalived-backup", "web1", "web2", "web3"]),
    ("Capa de aplicación", ["application-lb-master", "application-lb-backup",
        "application-keepalived-master", "application-keepalived-backup", "app1", "app2", "app3"]),
    ("Capa de datos", ["db-lb", "galera1", "galera2", "galera3", "mongodb", "mongodb2", "mongodb3",
        "redis", "redis2", "sentinel1", "sentinel2", "sentinel3"]),
    ("Monitoreo y arranque", ["nagios", "catalog-init", "mongo-init"]),
]
COLORES = {"verde": "#1f9d55", "amarillo": "#d69e2e", "rojo": "#e53e3e", "gris": "#718096"}

def sh(cmd, t=8):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t, stdin=subprocess.DEVNULL)
        return r.stdout.strip()
    except Exception:
        return ""

def leer_env():
    env = {}
    try:
        for l in open(".env"):
            l = l.strip()
            if l and not l.startswith("#") and "=" in l:
                k, v = l.split("=", 1)
                env[k] = v
    except FileNotFoundError:
        pass
    return env

def servicios():
    raw = sh("docker compose ps -a --format json", 12)
    items = []
    if raw.startswith("["):
        try:
            items = json.loads(raw)
        except Exception:
            pass
    else:
        for line in raw.splitlines():
            try:
                items.append(json.loads(line))
            except Exception:
                pass
    return {i.get("Service"): i for i in items}

def clasificar(nombre, i):
    if not i:
        return ("rojo", "no existe")
    st = (i.get("State") or "").lower()
    health = (i.get("Health") or "").lower()
    status = i.get("Status") or ""
    if st == "running":
        if health == "unhealthy":
            return ("rojo", "unhealthy")
        if health == "starting":
            return ("amarillo", "iniciando")
        return ("verde", "sano" if health == "healthy" else "arriba")
    if st in ("restarting", "created"):
        return ("amarillo", st)
    if nombre in INIT and "Exited (0)" in status:
        return ("gris", "terminó bien")
    if st == "exited":
        return ("rojo", "apagado")
    return ("rojo", st or "caído")

def extras(env):
    r = []
    t = sh('curl -s -o /dev/null -m 4 -w "%{http_code} %{time_total}" http://localhost/api/products/cheapest', 6).split()
    if len(t) == 2:
        r.append(("Tienda (extremo a extremo)", "HTTP %s en %.2f s" % (t[0], float(t[1])), "verde" if t[0] == "200" else "rojo"))
    else:
        r.append(("Tienda (extremo a extremo)", "sin respuesta", "rojo"))

    pw = env.get("MARIADB_ROOT_PASSWORD", "")
    n = ""
    for nodo in ("galera2", "galera3", "galera1"):
        n = sh("docker compose exec -T %s mysql -uroot -p'%s' -N -e \"SHOW STATUS LIKE 'wsrep_cluster_size'\" 2>/dev/null | awk '{print $2}'" % (nodo, pw), 8)
        if n:
            break
    r.append(("Nodos en el clúster Galera", n or "sin dato", "verde" if n == "3" else ("amarillo" if n else "rojo")))

    for capa, ip in (("presentation", "172.30.0.250"), ("application", "172.31.0.250")):
        quien = [x for x in ("master", "backup") if ip in sh("docker compose exec -T %s-keepalived-%s ip addr" % (capa, x), 6)]
        r.append(("IP virtual de %s (%s)" % (capa, ip), ", ".join("keepalived-" + q for q in quien) or "nadie la tiene", "verde" if len(quien) == 1 else "rojo"))

    user, mpw = env.get("MONGO_ROOT_USERNAME", ""), env.get("MONGO_ROOT_PASSWORD", "")
    prim = ""
    for nodo in ("mongodb", "mongodb2", "mongodb3"):
        prim = sh("docker compose exec -T %s mongosh --quiet -u '%s' -p '%s' --authenticationDatabase admin --eval 'rs.status().members.filter(m => m.stateStr == \"PRIMARY\").map(m => m.name).join(\",\")' 2>/dev/null" % (nodo, user, mpw), 10)
        if prim:
            break
    r.append(("Primario de MongoDB", prim or "ninguno", "verde" if prim else "rojo"))

    rm = ""
    for s in ("sentinel1", "sentinel2", "sentinel3"):
        rm = sh("docker compose exec -T %s redis-cli -p 26379 sentinel get-master-addr-by-name mymaster 2>/dev/null | head -1" % s, 6)
        if rm:
            break
    r.append(("Redis principal (según Sentinel)", rm or "sin dato", "verde" if rm else "rojo"))
    return r

def caja(titulo, detalle, color):
    return "<div class='caja' style='background:%s'><b>%s</b>%s</div>" % (COLORES[color], titulo, detalle)

def pagina(sv, ex):
    todos = [n for _, g in GRUPOS for n in g if n not in INIT]
    sanos = sum(1 for n in todos if clasificar(n, sv.get(n))[0] == "verde")
    h = ["<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='refresh' content='3'><title>Estado del sistema</title>",
         "<style>body{font-family:system-ui,sans-serif;background:#111827;color:#f3f4f6;margin:20px}",
         "h1{margin:0 0 4px}.sub{color:#9ca3af;margin-bottom:16px}",
         ".grupo{margin:14px 0}.grupo h2{font-size:15px;color:#d1d5db;margin:0 0 6px}",
         ".fila{display:flex;flex-wrap:wrap;gap:8px}",
         ".caja{min-width:170px;padding:8px 10px;border-radius:8px;color:white;font-size:13px}",
         ".caja b{display:block;font-size:14px}</style></head><body>",
         "<h1>Estado del sistema distribuido</h1>",
         "<div class='sub'>%d de %d componentes sanos &middot; actualizado %s</div>" % (sanos, len(todos), datetime.datetime.now().strftime("%H:%M:%S")),
         "<div class='grupo'><h2>Comprobaciones en vivo</h2><div class='fila'>"]
    for t, v, c in ex:
        h.append(caja(t, v, c))
    h.append("</div></div>")
    for titulo, nombres in GRUPOS:
        h.append("<div class='grupo'><h2>%s</h2><div class='fila'>" % titulo)
        for n in nombres:
            c, d = clasificar(n, sv.get(n))
            h.append(caja(n, d, c))
        h.append("</div></div>")
    h.append("<div class='sub'>Verde: sano &middot; Amarillo: iniciando o reiniciando &middot; Rojo: apagado o con falla &middot; Gris: tarea de arranque terminada</div></body></html>")
    return "".join(h)

def main():
    srv = subprocess.Popen(["python3", "-m", "http.server", "8090", "--bind", "127.0.0.1", "--directory", OUT_DIR],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("Panel en http://localhost:8090  (Ctrl+C para detener)")
    try:
        while True:
            env = leer_env()
            sv = servicios()
            ex = extras(env)
            tmp = OUT_DIR + "/index.tmp"
            with open(tmp, "w") as f:
                f.write(pagina(sv, ex))
            os.replace(tmp, OUT_DIR + "/index.html")
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        srv.terminate()

main()
