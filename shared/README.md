# shared/

Módulos **sin dependencias de npm** que usan tanto la API (`application/`) como el
worker (`worker/`). Las librerías externas (amqplib, el logger con OpenTelemetry, etc.)
se inyectan como parámetros, así cada servicio resuelve sus propios `node_modules`.

En las imágenes de contenedor este directorio se copia a `/app/shared` y la topología
a `/app/messaging`, por eso los Dockerfile usan la raíz del repositorio como contexto.
