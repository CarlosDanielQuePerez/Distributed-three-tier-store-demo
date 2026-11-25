#!/usr/bin/env bash
# Prepara una computadora con Windows + WSL 2 (Ubuntu) para ser nodo del clúster K3s
# del equipo. Se ejecuta DENTRO de WSL en cada computadora, una vez:
#
#   scripts/wsl-node-setup.sh "ssh-ed25519 AAAA... llave-publica-de-quien-corre-terraform"
#
# Qué hace:
#   1. Verifica que systemd esté activo (K3s y sshd lo necesitan) o lo activa.
#   2. Instala y arranca openssh-server (Terraform instala K3s por SSH).
#   3. Autoriza la llave SSH pública recibida.
#   4. Permite sudo sin contraseña para el usuario actual (lo usa Terraform por SSH).
#   5. Instala Tailscale y une la computadora a la red privada del equipo.
#   6. Comprueba los módulos del kernel que usa K3s (vxlan, br_netfilter, overlay).
# Al final imprime la IP 100.x.y.z que va en terraform.tfvars.
set -euo pipefail

PUBKEY=${1:-}
ME=$(id -un)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if ! grep -qi microsoft /proc/version; then
  echo "Este script es para WSL. En Linux nativo basta con openssh-server y la llave autorizada." >&2
fi

say "1/6 systemd"
if [ "$(ps -p 1 -o comm=)" != "systemd" ]; then
  if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
    printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
  fi
  cat <<'TXT'
systemd no está activo. Ya quedó habilitado en /etc/wsl.conf.
En PowerShell de Windows ejecuta:   wsl --update   y luego   wsl --shutdown
Abre otra vez Ubuntu y vuelve a correr este script.
TXT
  exit 1
fi
echo "systemd activo"

say "2/6 openssh-server"
sudo apt-get update -qq
sudo apt-get install -y -qq openssh-server curl ca-certificates >/dev/null
sudo systemctl enable --now ssh
echo "sshd escuchando en el puerto 22"

say "3/6 llave SSH autorizada"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
if [ -n "$PUBKEY" ]; then
  grep -qxF "$PUBKEY" ~/.ssh/authorized_keys || echo "$PUBKEY" >> ~/.ssh/authorized_keys
  echo "Llave agregada a ~/.ssh/authorized_keys"
else
  echo "No se pasó llave pública; agrégala después a ~/.ssh/authorized_keys"
fi

say "4/6 sudo sin contraseña para $ME (lo necesita Terraform por SSH)"
echo "$ME ALL=(ALL) NOPASSWD:ALL" | sudo tee "/etc/sudoers.d/90-k3s-$ME" >/dev/null
sudo chmod 440 "/etc/sudoers.d/90-k3s-$ME"
sudo visudo -cf "/etc/sudoers.d/90-k3s-$ME" >/dev/null && echo "ok"

say "5/6 Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
sudo systemctl enable --now tailscaled
if ! tailscale ip -4 >/dev/null 2>&1; then
  echo "Abre el enlace que aparece abajo e inicia sesión con la cuenta de Tailscale del equipo."
  sudo tailscale up --hostname "k3s-$(hostname | tr '[:upper:]_' '[:lower:]-')"
fi

say "6/6 módulos del kernel de WSL"
missing=0
for m in overlay br_netfilter vxlan; do
  if sudo modprobe "$m" 2>/dev/null || grep -qw "$m" /proc/modules || [ -d "/sys/module/$m" ]; then
    echo "  $m ok"
  else
    echo "  $m NO disponible"; missing=1
  fi
done
[ "$missing" = 0 ] || echo "Actualiza el kernel de WSL desde PowerShell:  wsl --update   (y luego wsl --shutdown)"

IP=$(tailscale ip -4 | head -1)
cat <<TXT

Listo. Datos para infra/terraform/envs/dev/terraform.tfvars:
  address  = "$IP"
  ssh_user = "$ME"

Prueba desde la otra computadora (también dentro de WSL):   ssh $ME@$IP
Deja una terminal de Ubuntu abierta mientras el clúster esté en uso: si se cierran todas,
Windows apaga WSL y el nodo se cae.
TXT
