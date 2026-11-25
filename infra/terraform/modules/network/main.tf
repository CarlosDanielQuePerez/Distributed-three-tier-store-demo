# Prepara la red de los nodos (una computadora por nodo en equipos de 3):
#  - /etc/hosts con todos los nodos (los nombres resuelven aunque no haya DNS en la LAN)
#  - Firewall (ufw, si está instalado) abierto solo a la LAN para los puertos de K3s,
#    etcd, flannel/wireguard, kubelet, MetalLB y el Ingress.

locals {
  hosts_block = join("\n", [for n in var.nodes : "${n.address} ${n.name}"])
  tcp_ports   = ["22", "80", "443", "6443", "2379:2380", "10250", "7946"]
  udp_ports   = ["8472", "51820:51821", "7946"]
}

resource "terraform_data" "node_network" {
  for_each = { for n in var.nodes : n.name => n }

  triggers_replace = [local.hosts_block, var.lan_cidr, join(",", local.tcp_ports), join(",", local.udp_ports)]

  connection {
    type        = "ssh"
    host        = each.value.address
    user        = each.value.ssh_user
    private_key = file(pathexpand(var.ssh_private_key_path))
  }

  provisioner "remote-exec" {
    inline = concat(
      [
        "set -e",
        "sudo hostnamectl set-hostname ${each.key} || true",
        "sudo sed -i '/# BEGIN store-cluster/,/# END store-cluster/d' /etc/hosts",
        "printf '%s\\n' '# BEGIN store-cluster' '${replace(local.hosts_block, "\n", "' '")}' '# END store-cluster' | sudo tee -a /etc/hosts >/dev/null",
        # Módulos y sysctl que necesita Kubernetes (bridge + forwarding)
        "printf 'overlay\\nbr_netfilter\\n' | sudo tee /etc/modules-load.d/k3s.conf >/dev/null",
        "sudo modprobe overlay || true; sudo modprobe br_netfilter || true",
        "printf 'net.ipv4.ip_forward=1\\nnet.bridge.bridge-nf-call-iptables=1\\n' | sudo tee /etc/sysctl.d/90-k3s.conf >/dev/null",
        "sudo sysctl --system >/dev/null",
        # En modo tailscale el tráfico entre nodos entra por tailscale0.
        "if [ '${var.overlay}' = tailscale ] && command -v ufw >/dev/null; then sudo ufw allow in on tailscale0; fi",
        "if command -v ufw >/dev/null; then",
      ],
      [for p in local.tcp_ports : "  sudo ufw allow from ${var.lan_cidr} to any port ${p} proto tcp"],
      [for p in local.udp_ports : "  sudo ufw allow from ${var.lan_cidr} to any port ${p} proto udp"],
      [
        "  sudo ufw allow from 10.42.0.0/16; sudo ufw allow from 10.43.0.0/16",
        "fi",
      ],
    )
  }
}
