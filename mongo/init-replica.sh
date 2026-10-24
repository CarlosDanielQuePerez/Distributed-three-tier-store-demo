#!/bin/bash
set -e
AUTH="-u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase admin"

until mongosh --quiet --host mongodb $AUTH --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; do
  echo "Esperando a mongodb..."; sleep 2
done

mongosh --quiet --host mongodb $AUTH --eval '
try { rs.status(); print("replica set ya inicializado"); }
catch (e) {
  rs.initiate({ _id: "rs0", members: [
    { _id: 0, host: "mongodb:27017",  priority: 2 },
    { _id: 1, host: "mongodb2:27017", priority: 1 },
    { _id: 2, host: "mongodb3:27017", priority: 1 }
  ]});
  print("replica set inicializado");
}'

until mongosh --quiet --host mongodb $AUTH --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; do
  echo "Esperando elección de primario..."; sleep 2
done
echo "PRIMARY listo"
