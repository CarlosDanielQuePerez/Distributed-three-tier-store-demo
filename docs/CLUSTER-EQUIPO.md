# Clúster K3s del equipo: 2 computadoras con Windows + WSL

Guía paso a paso para armar el clúster real del Parcial 2. Hay un nodo en cada
computadora:

| Computadora | Nodo | Rol | Responsable |
|-------------|------|-----|-------------|
| 1 | `k3s-node1` | **server**: plano de control (etcd) y cargas. Desde aquí se corren Terraform, kubectl y las pruebas | integrante 1 |
| 2 | `k3s-node2` | **agent**: solo cargas | integrante 2 |

## Plan B: una sola computadora

Si una de las dos computadoras no está disponible (nos pasó: se descompuso la segunda), el
clúster se arma completo en la computadora 1 con **k3d**. Cada nodo K3s (el server y el
agent) es un contenedor Docker, y Kubernetes ve **2 nodos**, igual que con dos
computadoras. Los manifiestos, Flux, las colas y las pruebas son los mismos; solo cambia
dónde corren los nodos. No hacen falta Tailscale, SSH ni Terraform. Terraform queda
validado (`terraform validate`) y listo para cuando haya dos computadoras.

Requisitos en la computadora: Docker Desktop con integración WSL, `.wslconfig` con
`memory=6GB` y `swap=4GB`, y en Ubuntu las herramientas `k3d`, `kubectl` y `flux`:

```bash
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
```

```bash
curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && sudo install -m 755 /tmp/kubectl /usr/local/bin/kubectl
```

```bash
curl -s https://fluxcd.io/install.sh | sudo bash
```

Apaga primero la pila de Docker Compose (`./apagar.sh`), porque las dos compiten por la
RAM. Después, desde la raíz del repositorio:

```bash
scripts/local-cluster.sh up
```

O con Flux desde GitHub, para demostrar la Fase 5. Necesita los pasos 4 y 5 de esta guía
(secretos SOPS y repositorio subido):

```bash
REPO_URL=https://github.com/<usuario>/Distributed-three-tier-store-demo scripts/local-cluster.sh gitops
```

Para ver los nodos y cuánta memoria usa cada uno:

```bash
scripts/local-cluster.sh status
```

Prueba de pérdida de nodo: `docker stop k3d-store-agent-0` durante la carga (`DURATION=180
pruebas/plataforma/run-chaos.sh baseline`), y luego `docker start k3d-store-agent-0`.

Para liberar toda la memoria al terminar:

```bash
scripts/local-cluster.sh down
```

> Para la entrega: expliquen al maestro que, por la falla de hardware, los dos nodos
> corrieron como contenedores en una misma computadora. La topología (1 server + 1 agent),
> los manifiestos y el proceso de Terraform para dos computadoras están en el repositorio.

## Por qué Tailscale

WSL 2 corre detrás de un NAT de Windows: otras computadoras de la red no pueden llegar a
su Ubuntu. Windows 11 lo resuelve con `networkingMode=mirrored`, pero **Windows 10 no tiene
esa opción**. Por eso los dos nodos se unen con **Tailscale**, una red privada (WireGuard)
que da a cada WSL una IP fija `100.x.y.z` y atraviesa el NAT.

- Funciona igual en Windows 10 y 11.
- Funciona aunque las computadoras estén en redes distintas, o en una red de la
  universidad que aísle a los equipos.
- K3s envía el tráfico entre nodos por la interfaz `tailscale0` (`flannel-iface`).
- No se usa MetalLB, porque no hay una red L2 compartida. El Ingress de Traefik queda
  publicado en los puertos 80 y 443 de cada nodo con servicelb de K3s.

Terraform lo configura con `overlay = "tailscale"` en `terraform.tfvars`, y Flux con
`clusters/dev` (que quita MetalLB).

## Requisitos

| | Cada computadora |
|-|------------------|
| Windows | 10 (21H2 o más reciente) u 11, con WSL 2 actualizado (`wsl --update`) |
| Distro | Ubuntu 22.04 o 24.04 en WSL 2 |
| RAM | 8 GB o más; asignar 5–6 GB a WSL (ver paso 1) |
| Cuenta | una cuenta gratuita de Tailscale **compartida por el equipo**, o una cuenta con el otro integrante invitado a la misma *tailnet* |

> Mientras el clúster esté en uso, no corran la pila de Docker Compose en la computadora 1:
> ambas quieren el puerto 80. Usen `./apagar.sh` antes.

---

## Paso 1 — Memoria de WSL (las dos computadoras)

En PowerShell de Windows, abre el archivo de configuración de WSL:

```powershell
notepad $env:UserProfile\.wslconfig
```

Escribe esto y guarda:

```ini
[wsl2]
memory=6GB
swap=4GB
```

Luego actualiza y reinicia WSL:

```powershell
wsl --update
```

```powershell
wsl --shutdown
```

## Paso 2 — Llave SSH de quien corre Terraform (solo computadora 1)

Dentro de Ubuntu (WSL):

```bash
test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
```

```bash
cat ~/.ssh/id_ed25519.pub
```

Copia la línea que empieza con `ssh-ed25519` y mándasela al otro integrante: la usa en el
paso 3.

## Paso 3 — Preparar cada nodo (las dos computadoras)

Cada integrante necesita el repositorio en su WSL. La computadora 2 solo usa el script, así
que basta copiar `scripts/wsl-node-setup.sh`.

```bash
cd ~/Distributed-three-tier-store-demo
```

```bash
scripts/wsl-node-setup.sh "ssh-ed25519 AAAA...la-llave-del-paso-2..."
```

El script activa systemd, instala openssh-server, autoriza la llave, habilita `sudo` sin
contraseña (Terraform lo necesita por SSH), instala Tailscale y revisa los módulos del
kernel. Si dice que systemd no estaba activo, ejecuta `wsl --shutdown` en PowerShell, abre
Ubuntu otra vez y vuelve a correr el script.

Tailscale muestra un enlace: ábrelo en el navegador e inicia sesión con la cuenta del
equipo. Al final, el script imprime el `address` (100.x.y.z) y el `ssh_user` de esa
computadora; anótalos.

Prueba la conexión desde la computadora 1:

```bash
ssh <usuario-de-la-computadora-2>@<ip-100.x-de-la-computadora-2> hostname
```

Haz lo mismo con tu propia IP 100.x: Terraform también entra por SSH al nodo 1.

> Deja una terminal de Ubuntu abierta en cada computadora mientras usen el clúster. Si se
> cierran todas, Windows apaga WSL y el nodo se cae.

## Paso 4 — Secretos (computadora 1)

Instala `sops` y `age`:

```bash
sudo apt-get install -y age && curl -fsSL -o /tmp/sops https://github.com/getsops/sops/releases/download/v3.10.2/sops-v3.10.2.linux.amd64 && sudo install -m 755 /tmp/sops /usr/local/bin/sops
```

Crea la llave y copia la línea `public key: age1...` que imprime:

```bash
age-keygen -o age.key
```

Reemplaza `age1replacewithyourpublickey...` en `.sops.yaml` por esa llave pública y genera
los Secrets cifrados:

```bash
scripts/generate-secrets.sh dev
```

`age.key` nunca se sube a Git (está en `.gitignore`). Guárdalo en un lugar seguro.

## Paso 5 — Subir el repositorio (computadora 1)

Flux lee el clúster desde GitHub. Haz commit de los cambios, incluyendo
`deploy/secrets/dev/store-secrets.sops.yaml` (va cifrado), y súbelos a la rama `main` de
tu repositorio.

Después, crea un *personal access token* de GitHub con permiso de administración sobre ese
repositorio. Terraform lo usa una sola vez, para registrar la *deploy key* de Flux.

## Paso 6 — Terraform: K3s y Flux (computadora 1)

Instala Terraform (u OpenTofu ≥ 1.10), `kubectl` y el CLI de `flux`. Luego:

```bash
cd infra/terraform/envs/dev
```

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edita `terraform.tfvars` con las IP 100.x y los usuarios del paso 3. Sin servidor S3 para
el estado, desactiva el backend remoto: renombra `backend.tf` a `backend.tf.off`, y el
estado quedará local en `terraform.tfstate`, que tampoco se sube.

```bash
terraform init
```

Primero, red, almacenamiento y K3s:

```bash
terraform apply -target=module.k3s
```

```bash
kubectl --kubeconfig kubeconfig-dev.yaml get nodes -o wide
```

Deben aparecer `k3s-node1` (control-plane) y `k3s-node2`, los dos `Ready`, con sus IP 100.x.

Después, Flux:

```bash
GITHUB_TOKEN=<token-del-paso-5> terraform apply
```

Sigue el avance hasta que `apps` quede `Ready` (la primera vez tarda 15–30 minutos).
`observability` aparece como **suspendida**: es normal, es opcional por RAM. Si les sobra
memoria, se enciende con
`flux --kubeconfig kubeconfig-dev.yaml resume kustomization observability`.

```bash
flux --kubeconfig kubeconfig-dev.yaml get kustomizations --watch
```

## Paso 7 — Probar la tienda

En el archivo hosts de Windows (`C:\Windows\System32\drivers\etc\hosts`, editado como
administrador), agrega:

```text
127.0.0.1 store.local grafana.store.local
```

WSL reenvía `localhost` a Windows, así que `http://store.local/` abre la tienda desde la
computadora 1. Desde la computadora 2, o desde cualquier equipo de la tailnet, usa la
IP 100.x del nodo en lugar de `127.0.0.1`.

Las pruebas de desempeño y de caos se corren desde la computadora 1:

```bash
export KUBECONFIG=$PWD/kubeconfig-dev.yaml
```

```bash
cd ~/Distributed-three-tier-store-demo && pruebas/plataforma/run-perf.sh
```

```bash
pruebas/plataforma/run-chaos.sh node-loss
```

En WSL, la prueba de pérdida de nodo se hace en la computadora 2 con
`sudo systemctl stop k3s-agent`. Para regresar el nodo: `sudo systemctl start k3s-agent`.

## Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| `ssh` no conecta a la IP 100.x | Tailscale caído o WSL apagado | `tailscale status` en las dos; abrir una terminal de Ubuntu |
| Nodo 2 `NotReady` | se cerró WSL en la computadora 2 | abrir Ubuntu; `sudo systemctl status k3s-agent` |
| Pods en `Pending` por memoria | WSL con poca RAM | subir `memory=` en `.wslconfig`; ver `kubectl describe pod` |
| `terraform apply` falla en `sudo` | sudo pide contraseña | volver a correr `scripts/wsl-node-setup.sh` |
| El puerto 80 no responde en Windows | Docker Compose ocupa el 80 | `./apagar.sh` |
| Pods sin red entre nodos | `vxlan` no está en el kernel de WSL | `wsl --update` y `wsl --shutdown` |
