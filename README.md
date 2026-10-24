# Demostración de tienda distribuida de tres capas

La pila (*stack*) sirve una tienda estática a través de tres nodos de presentación Nginx. Su capa de aplicación en Node.js consulta un clúster de MariaDB Galera para obtener los diez productos más baratos, almacena en caché esa lista en Redis y guarda las reseñas de productos en MongoDB. Instancias de HAProxy distribuyen las solicitudes dentro de cada capa, y Keepalived proporciona una IP virtual (VIP) maestro/respaldo (*master/backup*) para cada par de HAProxy.

## Arquitectura

<img width="3280" height="900" alt="Distribución de tres niveles" src="https://github.com/user-attachments/assets/edce06a5-2015-4d82-b4c6-2c92b890f31a" />

Las solicitudes de listas de productos consultan Redis en primer lugar; si ocurre un fallo de caché (*cache miss*), se consulta a MariaDB y luego se pobla Redis. Las solicitudes de reseñas utilizan MongoDB, usando MariaDB para verificar el producto antes de insertar la reseña. En esta configuración de Compose en un solo host, el puerto 80 del host es publicado por el contenedor maestro de presentación; la VIP de presentación no traslada el mapeo de puertos del host de Docker durante una conmutación por error (*failover*).

## Ejecución local

1. Copia `.env.example` a `.env` y reemplaza las contraseñas de ejemplo.
2. Inicia la pila con `docker compose up --build`.
3. Abre `http://localhost/` para la tienda y `http://localhost:8088/` para Nagios.

El endpoint de productos es `http://localhost/api/products/cheapest`; devuelve un JSON ordenado por precio ascendente. La tienda llama a este endpoint y renderiza los productos devueltos. La creación del esquema y la inserción de datos de prueba las realiza de forma idempotente el servicio `catalog-init` una vez que el primer nodo de Galera está saludable.

La tienda también muestra el rastreo en vivo de la solicitud para sus peticiones de API de productos y reseñas. Encabezados como `X-Request-Trace` en la respuesta de la API registran el balanceador de carga de presentación, el nodo web seleccionado, el balanceador de carga de aplicación, el nodo de aplicación y los almacenes de datos reales consultados por esa solicitud.
El menú del explorador de API de la tienda puede consultar `/`, `/health`, `/products/cheapest` y `/products/ST-001/reviews`.

Usa el menú del explorador de API de la tienda para consultar los endpoints de productos, reseñas, información del servicio y estado de salud (*health*). Su botón **Clear Redis catalog cache** llama a `POST /api/cache/clear`, el cual elimina únicamente la entrada en caché de los productos más baratos; la siguiente solicitud del catálogo volverá a llenarla desde MariaDB.

La aplicación utiliza Redis para almacenar en caché la respuesta de los productos más baratos durante 60 segundos. MongoDB almacena las reseñas de productos: usa `GET /api/products/ST-001/reviews` para leer las reseñas o envía un JSON como `{"reviewer":"Taylor","rating":5,"comment":"Great bag."}` a `POST /api/products/ST-001/reviews` para agregar una. El servicio de inicialización crea el índice de reseñas e inserta las reseñas de prueba de forma idempotente. MongoDB y Redis son privados dentro de la red de base de datos y no están expuestos en los puertos del host.

## Conmutación por error del balanceador de carga (*Load-balancer failover*)

La VIP de presentación es `172.30.0.250` y la VIP de aplicación es `172.31.0.250`. Cada par de Keepalived comparte el espacio de nombres de red (*network namespace*) de su contenedor HAProxy, utiliza VRRP unicast y monitorea el puerto de escucha local de HAProxy. Las solicitudes de aplicación desde Nginx utilizan la VIP flotante de aplicación.

Compose publica el puerto 80 del host en el contenedor maestro de presentación. El mapeo de puertos publicados de Docker apunta a ese contenedor específico, por lo que en un despliegue de Compose en un solo host, la conmutación por error de la VIP no traslada el mapeo del puerto del host. La VIP de presentación está disponible para otros contenedores en la red perimetral (*edge network*); exponla a través de una configuración de red/host que admita VIPs flotantes si requieres conmutación por error a nivel de host.
