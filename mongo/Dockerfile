FROM mongo:8
# Clave compartida entre los nodos del replica set (la misma imagen para los 3)
RUN head -c 512 /dev/urandom | base64 -w0 > /etc/mongo-keyfile \
 && chmod 400 /etc/mongo-keyfile \
 && chown mongodb:mongodb /etc/mongo-keyfile
