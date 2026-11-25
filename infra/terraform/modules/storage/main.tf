# Almacenamiento local de cada nodo para el provisioner local-path de K3s (PVCs de
# Galera, MongoDB, Redis, RabbitMQ, Loki, Tempo...). Los datos replicados por las bases
# hacen que perder un disco no pierda datos mientras quede quórum.

resource "terraform_data" "data_dir" {
  for_each = { for n in var.nodes : n.name => n }

  triggers_replace = [var.data_path]

  connection {
    type        = "ssh"
    host        = each.value.address
    user        = each.value.ssh_user
    private_key = file(pathexpand(var.ssh_private_key_path))
  }

  provisioner "remote-exec" {
    inline = [
      "set -e",
      "sudo mkdir -p ${var.data_path}",
      "sudo chmod 0711 ${var.data_path}",
      "df -h ${var.data_path} | tail -1",
    ]
  }
}
