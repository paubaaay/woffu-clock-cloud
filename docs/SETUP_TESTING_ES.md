# Tutorial rápido — configurar Woffu Clock para pruebas

Este documento explica cómo levantar una copia independiente de **Woffu Clock Cloud** para hacer pruebas con una **cuenta Woffu de test**.

> Importante: este proyecto está pensado para entornos/cuentas de prueba. No metas contraseñas en GitHub ni en archivos del repositorio.

## Qué hace la aplicación

La aplicación corre en Cloudflare Workers y usa:

- Cloudflare Worker para la webapp y el scheduler.
- Cloudflare Cron cada minuto.
- Cloudflare D1 para guardar configuración, calendario, plan semanal y logs.
- Woffu API para autenticar y crear fichajes.

Cuando está en modo LIVE y la escritura está habilitada, el scheduler puede enviar a Woffu los eventos del plan configurado.

La ejecución es **indefinida**: no existe una fecha de fin automática. El scheduler seguirá funcionando de lunes a viernes mientras la automatización esté activa y no se deshabilite expresamente.

---

# 1. Crear tu copia del repositorio

Haz un **Fork** de este repositorio en tu cuenta de GitHub.

Trabaja siempre sobre tu fork. Así cada persona tendrá su propio Worker, su propia base D1, sus propias credenciales y sus propios logs.

Repositorio original:

`paubaaay/woffu-clock-cloud`

---

# 2. Conectar el fork a Cloudflare Workers

En Cloudflare:

1. Entra en **Workers & Pages**.
2. Crea un nuevo Worker conectado a GitHub.
3. Selecciona tu fork de `woffu-clock-cloud`.
4. Usa la rama `main`.
5. El proyecto ya incluye `package.json` y `wrangler.jsonc`.
6. El deploy usa Wrangler (`npx wrangler deploy`).

El Worker debe usar como entrypoint el definido en `wrangler.jsonc`.

Actualmente:

```json
"main": "src/index-v9.js"
```

---

# 3. Crear la base de datos D1

En Cloudflare crea una base D1 nueva para tu copia, por ejemplo:

`woffu-clock-db-tu-nombre`

Después añádela como binding del Worker con este nombre exacto:

```text
DB
```

El código crea automáticamente las tablas necesarias la primera vez que se inicializa la app, así que no hace falta ejecutar SQL manualmente.

Si Cloudflare te pide asociar explícitamente el `database_id` en Wrangler, usa el ID de la base D1 que acabas de crear manteniendo siempre el binding como `DB`.

---

# 4. Configurar los secretos

En tu Worker abre:

**Settings → Variables and Secrets**

Crea estos tres valores como **Secret**:

```text
ADMIN_PASSWORD
WOFFU_EMAIL
WOFFU_PASSWORD
```

Significado:

- `ADMIN_PASSWORD`: contraseña para entrar en la webapp.
- `WOFFU_EMAIL`: email de tu cuenta Woffu de prueba.
- `WOFFU_PASSWORD`: contraseña de tu cuenta Woffu de prueba.

El usuario de Basic Auth de la webapp es:

```text
admin
```

No pongas ninguno de estos valores en GitHub.

---

# 5. Configurar las variables de funcionamiento

En la misma pantalla crea estas variables como **Text**:

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
```

Empieza siempre así.

El repositorio usa:

```json
"keep_vars": true
```

para que las variables creadas desde el dashboard no desaparezcan en futuros deploys.

---

# 6. Primer deploy y comprobación

Después del deploy abre:

```text
https://TU-WORKER.workers.dev/health
```

Antes de habilitar escrituras reales deberías ver algo equivalente a:

```json
{
  "ok": true,
  "app": "woffu-clock-cloud",
  "version": "3.3.0-scheduled-woffu-test",
  "mode": "TEST",
  "woffuCredentialsConfigured": true,
  "woffuWriteEnabled": false,
  "liveManualPunchReady": false,
  "scheduledWoffuWritesEnabled": false
}
```

Si `woffuCredentialsConfigured` aparece en `false`, revisa `WOFFU_EMAIL` y `WOFFU_PASSWORD`.

---

# 7. Comprobar primero la conexión con Woffu

Abre:

```text
https://TU-WORKER.workers.dev/api/woffu/test
```

La app debe poder:

1. Autenticarse en `/token`.
2. Obtener `access_token`.
3. Consultar `/api/users`.
4. Obtener `UserId` y `CompanyId`.
5. Consultar `/api/companies/{CompanyId}`.
6. Obtener el dominio Woffu correspondiente.

Esta prueba no crea ningún fichaje.

---

# 8. Probar un fichaje manual real

Cuando la conexión de lectura ya funcione, cambia temporalmente:

```text
MODE = LIVE
WOFFU_WRITE_ENABLED = true
```

Guarda los cambios y comprueba `/health`.

Debe indicar:

```text
liveManualPunchReady: true
```

Después abre:

```text
https://TU-WORKER.workers.dev/woffu/punch
```

Pulsa **Fichar ahora** una sola vez y comprueba que aparece el registro en tu cuenta Woffu de prueba.

Puedes pulsarlo una segunda vez para verificar el ciclo contrario de Woffu.

---

# 9. Configurar el scheduler

Entra en la webapp principal:

```text
https://TU-WORKER.workers.dev/
```

Usuario:

```text
admin
```

Contraseña:

```text
valor de ADMIN_PASSWORD
```

En **Ajustes** configura las cuatro horas base:

```text
Entrada mañana
Salida mediodía
Entrada mediodía
Salida tarde
```

Reglas actuales:

- Las cuatro horas deben estar en orden cronológico.
- El descanso de mediodía debe ser como mínimo de 1 hora.
- El horario base debe sumar exactamente 8 horas de trabajo.
- El generador puede añadir un offset aleatorio de 0 a 4:59 a cada evento.
- La semana se equilibra para mantener el objetivo total de horas de los días laborables.
- Los días marcados como vacaciones no generan fichajes.

Después pulsa **Regenerar semana**.

La web mostrará las horas exactas planificadas, incluidos segundos.

---

# 10. Activar el scheduler real

Para que los eventos programados se envíen a Woffu necesitas simultáneamente:

```text
MODE = LIVE
WOFFU_WRITE_ENABLED = true
Automatización = activa
```

Comprueba de nuevo:

```text
/health
```

Debe mostrar:

```text
scheduledWoffuWritesEnabled: true
```

El cron de Cloudflare se ejecuta cada minuto y busca si existe un evento del plan dentro de ese minuto.

Cuando llega el evento:

```text
Cloudflare Cron
→ comprueba automatización
→ comprueba vacaciones
→ comprueba pausas y eventos manuales
→ evita duplicados
→ autentica en Woffu
→ obtiene UserId / CompanyId / Domain
→ POST /api/svc/signs/signs
→ registra SUCCESS en D1
```

El timestamp enviado a Woffu corresponde a la **hora exacta programada del plan**, incluidos los segundos.

---

# 11. Hacer una prueba rápida del scheduler

Para no esperar horas:

1. Configura una hora base cercana a la hora actual.
2. Mantén las reglas de 8 horas totales y 1 hora mínima de descanso.
3. Guarda.
4. Pulsa **Regenerar semana**.
5. Mira la hora exacta generada para el siguiente evento.
6. Activa la automatización.
7. Espera a que llegue esa hora.
8. Comprueba Woffu.
9. Comprueba el log de la webapp.

El evento debería aparecer como:

```text
SUCCESS
```

---

# 12. Vacaciones, pausas y acciones manuales

La aplicación permite marcar días laborables como vacaciones.

Un día marcado como vacaciones queda excluido del plan y del objetivo semanal.

También existe la posibilidad de pausar eventos posteriores de un día y de registrar overrides manuales desde la webapp.

Estos mecanismos se revisan antes de ejecutar un evento automático.

---

# 13. ¿La automatización se detiene sola?

No.

La configuración actual es **indefinida**.

Mientras mantengas:

```text
MODE = LIVE
WOFFU_WRITE_ENABLED = true
Automatización = activa
```

el Worker seguirá comprobando el plan cada minuto y generará las semanas siguientes cuando sea necesario.

## Cómo detenerla

La forma más rápida desde la webapp es desactivar:

```text
Automatización = desactivada
```

Para bloquear además cualquier escritura a Woffu desde Cloudflare puedes poner:

```text
WOFFU_WRITE_ENABLED = false
```

Y para volver completamente a simulación:

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
```

Configuración recomendada cuando hayas terminado las pruebas:

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
Automatización = desactivada
```

---

# 14. Diagnóstico rápido

## `/health`

Estado general de la aplicación.

## `/api/woffu/test`

Comprueba autenticación y lecturas de Woffu sin fichar.

## `/woffu/punch`

Prueba manual de escritura utilizando la hora del momento.

## Logs de la webapp

Permiten comprobar si un evento programado terminó en `SUCCESS`, `FAILED` o estado de prueba.

---

# 15. Variables finales de referencia

## Secrets

```text
ADMIN_PASSWORD
WOFFU_EMAIL
WOFFU_PASSWORD
```

## Text

Para pruebas sin escritura:

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
```

Para probar escritura y scheduler contra una cuenta Woffu de test:

```text
MODE = LIVE
WOFFU_WRITE_ENABLED = true
```

---

# Checklist final

Antes de dejar el scheduler activo confirma:

- [ ] Estoy usando una cuenta Woffu de prueba.
- [ ] `WOFFU_EMAIL` y `WOFFU_PASSWORD` son Secrets.
- [ ] `ADMIN_PASSWORD` es Secret.
- [ ] La base D1 está vinculada como `DB`.
- [ ] `/api/woffu/test` funciona.
- [ ] El fichaje manual funciona.
- [ ] `/health` muestra `scheduledWoffuWritesEnabled: true`.
- [ ] He revisado las horas exactas generadas en la semana.
- [ ] He revisado vacaciones y pausas.
- [ ] Sé cómo desactivar la automatización al terminar.

Con esos puntos verificados, la copia está lista para pruebas automáticas.
