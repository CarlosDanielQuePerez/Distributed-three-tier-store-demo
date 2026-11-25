# deploy/local

Variantes para el clúster local de `scripts/local-cluster.sh` (k3d: 3 servidores K3s en
contenedores Docker). No las usa Flux; existen porque en local:

- k3d ya trae su propio balanceador (servicelb + `k3d-serverlb`), así que no se instala
  MetalLB ni su pool de IPs;
- las imágenes se construyen en la máquina (`:local`), no vienen de GHCR firmadas, así que
  no se aplica la política de verificación de firmas de Kyverno;
- `LITE=1` omite Chaos Mesh, Kyverno y KEDA para que quepa en menos RAM.
