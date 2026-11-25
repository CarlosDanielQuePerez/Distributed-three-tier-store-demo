# Instala K3s con etcd embebido: el primer servidor inicializa el clúster (cluster-init)
# y el resto se une según su rol:
#  - server: plano de control + etcd + cargas (con 3 servidores hay HA del plano de control)
#  - agent:  solo cargas
# Equipo de 2 computadoras: 1 server + 1 agent (dos servidores etcd no toleran fallas).

resource "random_password" "cluster_token" {
  length  = 48
  special = false
}

locals {
  servers   = [for n in var.nodes : n if n.role == "server"]
  bootstrap = local.servers[0]
  joiners   = [for n in var.nodes : n if n.name != local.bootstrap.name]
  tls_sans  = distinct(concat([for n in local.servers : n.address], [for n in local.servers : n.name], var.extra_tls_sans))
  install = {
    for n in var.nodes : n.name => "curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='${var.k3s_version}' INSTALL_K3S_EXEC=${n.role} sudo -E sh -"
  }

  configs = {
    for n in var.nodes : n.name => templatefile("${path.module}/templates/config.yaml.tftpl", {
      bootstrap    = n.name == local.bootstrap.name
      agent        = n.role == "agent"
      join_address = local.bootstrap.address
      token        = random_password.cluster_token.result
      node_name    = n.name
      node_ip      = n.address
      tls_sans     = local.tls_sans
      extra_args   = var.extra_args
      flannel_if   = var.flannel_iface
      no_slb       = var.disable_servicelb
    })
  }
}

resource "terraform_data" "bootstrap" {
  triggers_replace = [local.configs[local.bootstrap.name], var.k3s_version]

  connection {
    type        = "ssh"
    host        = local.bootstrap.address
    user        = local.bootstrap.ssh_user
    private_key = file(pathexpand(var.ssh_private_key_path))
  }

  provisioner "file" {
    content     = local.configs[local.bootstrap.name]
    destination = "/tmp/k3s-config.yaml"
  }

  provisioner "file" {
    source      = "${path.module}/templates/audit-policy.yaml"
    destination = "/tmp/k3s-audit-policy.yaml"
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "sudo mkdir -p /etc/rancher/k3s /var/lib/rancher/k3s/server/logs",
      "sudo install -m 600 /tmp/k3s-config.yaml /etc/rancher/k3s/config.yaml",
      "sudo install -m 600 /tmp/k3s-audit-policy.yaml /etc/rancher/k3s/audit-policy.yaml",
      "rm -f /tmp/k3s-config.yaml /tmp/k3s-audit-policy.yaml",
      local.install[local.bootstrap.name],
      "until sudo k3s kubectl get --raw /readyz >/dev/null 2>&1; do sleep 3; done",
      "sudo k3s kubectl get nodes -o wide",
    ]
  }
}

resource "terraform_data" "join" {
  for_each   = { for n in local.joiners : n.name => n }
  depends_on = [terraform_data.bootstrap]

  triggers_replace = [local.configs[each.key], var.k3s_version]

  connection {
    type        = "ssh"
    host        = each.value.address
    user        = each.value.ssh_user
    private_key = file(pathexpand(var.ssh_private_key_path))
  }

  provisioner "file" {
    content     = local.configs[each.key]
    destination = "/tmp/k3s-config.yaml"
  }

  provisioner "file" {
    source      = "${path.module}/templates/audit-policy.yaml"
    destination = "/tmp/k3s-audit-policy.yaml"
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "sudo mkdir -p /etc/rancher/k3s /var/lib/rancher/k3s/server/logs",
      "sudo install -m 600 /tmp/k3s-config.yaml /etc/rancher/k3s/config.yaml",
      "sudo install -m 600 /tmp/k3s-audit-policy.yaml /etc/rancher/k3s/audit-policy.yaml",
      "rm -f /tmp/k3s-config.yaml /tmp/k3s-audit-policy.yaml",
      local.install[each.key],
    ]
  }
}

# Descarga el kubeconfig del primer nodo y apunta el servidor a su IP de la LAN.
resource "terraform_data" "kubeconfig" {
  depends_on       = [terraform_data.join]
  triggers_replace = [terraform_data.bootstrap.id]

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      ssh -o StrictHostKeyChecking=accept-new -i '${pathexpand(var.ssh_private_key_path)}' '${local.bootstrap.ssh_user}@${local.bootstrap.address}' 'sudo cat /etc/rancher/k3s/k3s.yaml' \
        | sed 's#https://127.0.0.1:6443#https://${local.bootstrap.address}:6443#' > '${var.kubeconfig_path}'
      chmod 600 '${var.kubeconfig_path}'
    EOT
  }
}
