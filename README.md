# woffu-clock-cloud

Cloud Woffu clock automation using Cloudflare Workers.

## Tutorial de configuración para pruebas

Para crear una copia independiente del proyecto y configurarla con una cuenta Woffu de test, sigue esta guía:

[docs/SETUP_TESTING_ES.md](docs/SETUP_TESTING_ES.md)

La guía cubre:

- Fork del repositorio.
- Cloudflare Worker.
- Base D1.
- Secrets y variables.
- Prueba de autenticación Woffu.
- Prueba manual de fichaje.
- Configuración del scheduler.
- Activación y parada de la automatización.
- Diagnóstico y checklist final.

## Estado actual

El entrypoint activo se define en `wrangler.jsonc`.

La automatización programada no tiene una fecha de fin automática: permanece activa mientras la configuración de ejecución y el interruptor de automatización lo permitan. Consulta el tutorial antes de habilitar escritura programada.
