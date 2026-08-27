# Woffu Clock Cloud

Webapp de prueba para planificar y automatizar fichajes de una cuenta Woffu mediante Cloudflare Workers.

## Tutorial completo para principiantes

Si empiezas sin cuenta de GitHub o Cloudflare y no tienes conocimientos técnicos, sigue la guía paso a paso:

### [Abrir la guía completa de configuración y uso](docs/SETUP_TESTING_ES.md)

La guía explica desde cero:

- Cómo crear las cuentas de GitHub y Cloudflare, con enlaces oficiales.
- Cómo hacer tu propia copia del repositorio sin instalar programas.
- Cómo desplegar el Worker y comprobar la base D1.
- Cómo guardar las credenciales correctamente como secretos.
- Cómo probar la conexión sin fichar.
- Qué hace cada pantalla de la webapp.
- Cómo probar un fichaje manual y el scheduler de forma controlada.
- Cómo detener, actualizar y diagnosticar la aplicación.

> Utiliza únicamente una cuenta Woffu de prueba o una cuenta para la que tengas autorización expresa. Empieza siempre con `MODE=TEST`, `WOFFU_WRITE_ENABLED=false` y la automatización pausada.

## Estado actual

El entrypoint activo está definido en `wrangler.jsonc`. La automatización no tiene fecha de fin automática: continúa mientras los controles de Cloudflare y el interruptor de la webapp permitan su ejecución.
