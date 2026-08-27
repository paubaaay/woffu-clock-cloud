# Guía completa desde cero — configurar Woffu Clock Cloud

Esta guía está pensada para una persona sin experiencia técnica y explica todo el proceso usando únicamente el navegador. No necesitas saber programar, instalar Git, usar una terminal, comprar un dominio ni ejecutar SQL.

Al terminar tendrás:

- Tu propia copia del proyecto en GitHub.
- Una webapp desplegada en Cloudflare con una dirección `workers.dev`.
- Una base de datos D1 independiente.
- Tus contraseñas guardadas como secretos, fuera del código.
- Un modo de prueba que no ficha en Woffu.
- Una forma controlada de probar un fichaje y, solo después, la automatización.
- Una explicación clara de cada pantalla y de cómo detener todo.

> **Uso autorizado y de prueba.** Utiliza únicamente una cuenta Woffu de pruebas o una cuenta para la que tengas autorización expresa. Los fichajes pueden formar parte de registros laborales. No actives escrituras reales hasta entender los tres interruptores explicados en esta guía.

> **Nunca compartas contraseñas.** No escribas `ADMIN_PASSWORD`, `WOFFU_EMAIL` ni `WOFFU_PASSWORD` en GitHub, en el código, en capturas de pantalla, en incidencias públicas ni en mensajes.

## Índice

1. [Qué vas a crear y cómo funciona](#1-qué-vas-a-crear-y-cómo-funciona)
2. [Qué necesitas antes de empezar](#2-qué-necesitas-antes-de-empezar)
3. [Crear una cuenta de GitHub](#3-crear-una-cuenta-de-github)
4. [Crear tu copia del proyecto en GitHub](#4-crear-tu-copia-del-proyecto-en-github)
5. [Crear una cuenta de Cloudflare](#5-crear-una-cuenta-de-cloudflare)
6. [Crear el Worker, conectar GitHub y desplegar](#6-crear-el-worker-conectar-github-y-desplegar)
7. [Comprobar la base de datos D1](#7-comprobar-la-base-de-datos-d1)
8. [Configurar contraseñas y modo seguro](#8-configurar-contraseñas-y-modo-seguro)
9. [Encontrar y abrir la dirección de la webapp](#9-encontrar-y-abrir-la-dirección-de-la-webapp)
10. [Hacer las primeras comprobaciones sin fichar](#10-hacer-las-primeras-comprobaciones-sin-fichar)
11. [Cómo se usa la webapp](#11-cómo-se-usa-la-webapp)
12. [Probar el plan automático sin escribir en Woffu](#12-probar-el-plan-automático-sin-escribir-en-woffu)
13. [Probar un único fichaje real de forma controlada](#13-probar-un-único-fichaje-real-de-forma-controlada)
14. [Activar la automatización real](#14-activar-la-automatización-real)
15. [Detener la automatización](#15-detener-la-automatización)
16. [Actualizar la webapp en el futuro](#16-actualizar-la-webapp-en-el-futuro)
17. [Solución de problemas](#17-solución-de-problemas)
18. [Preguntas frecuentes](#18-preguntas-frecuentes)
19. [Checklist final](#19-checklist-final)

---

## 1. Qué vas a crear y cómo funciona

La solución utiliza cuatro piezas:

| Pieza | Explicación sencilla | Qué guarda o hace |
| --- | --- | --- |
| GitHub | Una carpeta online con el código de la aplicación. | Guarda tu copia del proyecto y su historial. |
| Cloudflare Worker | El ordenador en la nube que publica la webapp y ejecuta el reloj automático. | Sirve la web y revisa el plan una vez por minuto. |
| Cloudflare D1 | La pequeña base de datos privada de tu copia. | Guarda horario, vacaciones, plan semanal, pausas y registros. |
| Woffu | El servicio externo donde se crean los fichajes. | Recibe un fichaje únicamente cuando las escrituras reales están habilitadas. |

El recorrido normal es:

```text
Tú configuras el horario en la webapp
                ↓
Cloudflare D1 guarda la configuración y el plan
                ↓
Cloudflare Cron revisa el plan cada minuto
                ↓
Si todos los controles permiten escribir, envía el fichaje a Woffu
                ↓
La webapp muestra el resultado en “Últimas ejecuciones”
```

### Conceptos que conviene conocer

- **Repositorio:** conjunto de archivos del proyecto guardados en GitHub.
- **Fork:** copia del repositorio dentro de tu propia cuenta de GitHub.
- **Deploy o despliegue:** publicación de la aplicación en Cloudflare.
- **Worker:** aplicación que Cloudflare ejecuta en Internet.
- **D1:** base de datos de Cloudflare usada por esta aplicación.
- **Secret:** valor cifrado cuyo contenido deja de ser visible después de guardarlo.
- **Cron o scheduler:** reloj que despierta la aplicación cada minuto.
- **Binding `DB`:** conexión entre el Worker y su base D1. El nombre debe ser exactamente `DB`.

### No necesitas un dominio propio

Cloudflare proporciona una dirección gratuita con este formato:

```text
https://woffu-clock-cloud.TU-SUBDOMINIO.workers.dev
```

La documentación oficial explica que `workers.dev` permite publicar un Worker sin añadir un dominio propio: [Cloudflare — workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

---

## 2. Qué necesitas antes de empezar

Prepara lo siguiente:

- Un correo electrónico al que puedas acceder.
- Una cuenta Woffu de prueba autorizada.
- El email y la contraseña de esa cuenta Woffu.
- Una contraseña nueva y exclusiva para proteger la webapp.
- Una sesión tranquila para hacer el proceso y las comprobaciones.

### Elige una contraseña de administración segura

La contraseña que guardarás como `ADMIN_PASSWORD` protege la webapp. Debe ser distinta de tu contraseña de GitHub, Cloudflare y Woffu.

Una buena contraseña:

- Es larga.
- Es única para esta webapp.
- No contiene tu nombre, empresa o fechas fáciles de adivinar.
- Se guarda en un gestor de contraseñas.

### Si todavía no tienes acceso al repositorio

El proyecto original está en:

[Abrir `paubaaay/woffu-clock-cloud` en GitHub](https://github.com/paubaaay/woffu-clock-cloud)

Si GitHub muestra **404**, **Not Found** o no permite hacer el fork, normalmente significa que el repositorio es privado o que todavía no tienes permiso. Pide al propietario que:

1. Te invite al repositorio con tu usuario de GitHub.
2. Permita crear forks si el repositorio es privado.
3. Te avise cuando la invitación esté enviada.

Después abre el email de GitHub y acepta la invitación antes de continuar.

---

## 3. Crear una cuenta de GitHub

GitHub guardará tu copia del código. Crear la cuenta no instala nada en tu ordenador.

### Paso 3.1 — Abrir el registro

Abre:

[Crear una cuenta gratuita de GitHub](https://github.com/signup)

La guía oficial de GitHub está aquí:

[GitHub Docs — Crear una cuenta](https://docs.github.com/es/account-and-profile/how-tos/account-management/creating-an-account-on-github)

### Paso 3.2 — Completar los datos

GitHub te pedirá normalmente:

1. Tu correo electrónico.
2. Una contraseña.
3. Un nombre de usuario público.
4. Tu país o región.
5. Una comprobación para demostrar que eres una persona.

El nombre de usuario formará parte de la dirección de tu copia. Por ejemplo:

```text
https://github.com/TU-USUARIO/woffu-clock-cloud
```

### Paso 3.3 — Verificar el correo

1. Abre el mensaje que GitHub envía a tu correo.
2. Pulsa el enlace de verificación.
3. Vuelve a GitHub e inicia sesión.

Sin verificar el correo, GitHub puede impedir acciones básicas como crear tu copia del repositorio.

### Paso 3.4 — Proteger la cuenta

GitHub recomienda activar la autenticación en dos pasos:

[GitHub Docs — Configurar la autenticación en dos pasos](https://docs.github.com/es/authentication/securing-your-account-with-two-factor-authentication-2fa/configuring-two-factor-authentication)

### Comprobación

Este paso está terminado si puedes entrar en [github.com](https://github.com/) y ves tu avatar o icono de usuario en la esquina superior derecha.

---

## 4. Crear tu copia del proyecto en GitHub

No trabajes directamente sobre el repositorio original. Un fork permite que cada persona tenga su propia copia y que Cloudflare despliegue esa copia por separado.

La explicación oficial de GitHub está aquí:

[GitHub Docs — Crear un fork de un repositorio](https://docs.github.com/es/pull-requests/collaborating-with-pull-requests/working-with-forks/fork-a-repo)

### Paso 4.1 — Abrir el proyecto original

Abre:

[Repositorio original de Woffu Clock Cloud](https://github.com/paubaaay/woffu-clock-cloud)

### Paso 4.2 — Pulsar “Fork”

1. Busca el botón **Fork** en la parte superior derecha.
2. Púlsalo.
3. En **Owner**, elige tu cuenta personal.
4. Mantén el nombre `woffu-clock-cloud`.
5. Puedes dejar marcada la opción **Copy the default branch only**.
6. Pulsa **Create fork**.

GitHub abrirá tu nueva copia cuando termine.

### Paso 4.3 — Confirmar que la copia es tuya

Comprueba que la dirección del navegador contiene tu usuario:

```text
https://github.com/TU-USUARIO/woffu-clock-cloud
```

También deberías ver un texto parecido a:

```text
forked from paubaaay/woffu-clock-cloud
```

### No necesitas descargar el repositorio

Para seguir este tutorial no necesitas pulsar **Code**, clonar archivos, instalar Git ni usar GitHub Desktop. Cloudflare leerá directamente tu fork online.

---

## 5. Crear una cuenta de Cloudflare

Cloudflare publicará la webapp y ejecutará la automatización aunque tu ordenador esté apagado.

### Paso 5.1 — Abrir el registro

Abre:

[Crear una cuenta de Cloudflare](https://dash.cloudflare.com/sign-up)

Guía oficial:

[Cloudflare Docs — Crear una cuenta](https://developers.cloudflare.com/fundamentals/account/create-account/)

### Paso 5.2 — Crear y verificar la cuenta

1. Introduce tu correo y una contraseña segura.
2. Pulsa **Create Account**.
3. Abre el correo de verificación de Cloudflare.
4. Confirma tu dirección.
5. Inicia sesión en el [panel de Cloudflare](https://dash.cloudflare.com/).

Cloudflare da acceso por defecto al plan Workers Free y D1 dispone de límites gratuitos. Si el panel ofrece varios planes, elige la opción gratuita para este entorno de prueba y revisa siempre las condiciones vigentes:

- [Cloudflare Docs — Precio y límites de Workers](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Docs — Precio y límites de D1](https://developers.cloudflare.com/d1/platform/pricing/)

### No añadas una página web ni un dominio

Si Cloudflare te pregunta por un dominio, puedes omitir ese paso. Este proyecto usa la dirección `workers.dev` y no necesita cambiar DNS.

### Comprobación

Este paso está terminado si puedes abrir el panel de Cloudflare y seleccionar tu cuenta.

---

## 6. Crear el Worker, conectar GitHub y desplegar

Cloudflare permite importar un repositorio al crear un Worker. Sin embargo, este proyecto declara tres secretos obligatorios y Wrangler comprueba que ya existan antes de aceptar el despliegue. Para evitar un primer build fallido, la secuencia más sencilla es:

```text
Crear un Worker vacío con el nombre correcto
→ guardar en él los secretos obligatorios
→ conectar ese Worker a tu fork
→ desplegar el código definitivo
```

Cloudflare documenta tanto la creación de un Worker nuevo como la conexión de un Worker existente:

[Cloudflare Docs — Conectar un repositorio a Workers](https://developers.cloudflare.com/workers/ci-cd/builds/)

También documenta la validación previa de los secretos declarados como obligatorios:

[Cloudflare Docs — Propiedad `secrets.required`](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets-configuration-property)

### Paso 6.1 — Crear primero un Worker vacío

1. Entra en el [panel de Cloudflare](https://dash.cloudflare.com/).
2. Elige tu cuenta si aparece una lista.
3. En el menú, entra en **Workers & Pages**.
4. Pulsa **Create application**.
5. Busca **Start with Hello World!** y pulsa **Get started**.
6. En el nombre escribe exactamente:

   ```text
   woffu-clock-cloud
   ```

7. Pulsa **Deploy**.
8. Cuando termine, pulsa **Continue to project** o vuelve a **Workers & Pages** y abre `woffu-clock-cloud`.

Este “Hello World” es solo una base temporal. El código definitivo lo sustituirá al conectar GitHub.

> **El nombre es obligatorio.** Debe coincidir con el campo `name` de `wrangler.jsonc`. No añadas tu usuario, espacios, mayúsculas ni otro sufijo.

Cloudflare cambia ocasionalmente los textos de sus pantallas. Si no ves exactamente esas palabras, busca la opción equivalente a **crear un Worker básico** o **empezar con Hello World**.

### Paso 6.2 — Guardar los valores obligatorios

Dentro del Worker vacío abre:

```text
Settings
→ Variables and Secrets
```

Pulsa **Add** y crea:

| Nombre exacto | Tipo | Valor |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | Tu contraseña nueva para la webapp. |
| `WOFFU_EMAIL` | Secret | Email de la cuenta Woffu de prueba. |
| `WOFFU_PASSWORD` | Secret | Contraseña de la cuenta Woffu de prueba. |
| `MODE` | Text o Plaintext | `TEST` |
| `WOFFU_WRITE_ENABLED` | Text o Plaintext | `false` |

1. Revisa que los cinco nombres sean exactos.
2. Pulsa **Deploy**, **Save and Deploy** o el botón equivalente.
3. Espera a que Cloudflare aplique los cambios.

Los tres primeros deben ser **Secret**, nunca texto visible. El [apartado 8](#8-configurar-contraseñas-y-modo-seguro) explica cada valor y los controles de escritura con más detalle.

### Paso 6.3 — Abrir la conexión con GitHub

1. Continúa dentro de `Workers & Pages → woffu-clock-cloud`.
2. Abre **Settings**.
3. Entra en **Builds**.
4. En **Git Repository**, pulsa **Connect**.
5. Elige **GitHub**.

Esta es la ruta indicada por Cloudflare para conectar un Worker ya existente.

### Paso 6.4 — Autorizar GitHub y elegir tu fork

La primera vez, Cloudflare pedirá permiso para acceder a GitHub:

1. Inicia sesión en GitHub si se solicita.
2. Autoriza la aplicación **Cloudflare Workers and Pages**.
3. Si GitHub permite elegir entre todos los repositorios o solo algunos, selecciona **Only select repositories**.
4. Marca únicamente `TU-USUARIO/woffu-clock-cloud`.
5. Confirma la autorización.
6. De vuelta en Cloudflare, selecciona tu cuenta de GitHub.
7. Busca `woffu-clock-cloud`.
8. Verifica que el propietario es tu usuario, no el propietario original.
9. Selecciona el repositorio.

Dar acceso solo al repositorio necesario reduce el alcance del permiso.

Si el fork no aparece, abre [las aplicaciones instaladas de GitHub](https://github.com/settings/installations), entra en **Cloudflare Workers and Pages** y añade ese repositorio.

### Paso 6.5 — Revisar la configuración del build

Usa estos valores:

| Campo de Cloudflare | Valor |
| --- | --- |
| Worker ya creado | `woffu-clock-cloud` |
| Rama de producción | `main` |
| Directorio raíz | Vacío o `/` |
| Comando de build | Vacío |
| Comando de deploy | `npx wrangler deploy` |

No necesitas crear un token de API manual: la integración de Cloudflare puede generar el necesario para sus builds.

Referencia oficial de estos campos:

[Cloudflare Docs — Configuración de Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

Guarda la conexión y la configuración.

### Paso 6.6 — Iniciar el primer build del repositorio

Si Cloudflare ofrece **Save and Deploy**, **Trigger build** o inicia un build automáticamente, úsalo y pasa al paso siguiente.

Si solo guarda la conexión y no empieza ningún build, haz un commit inofensivo desde el navegador:

1. Abre tu fork `https://github.com/TU-USUARIO/woffu-clock-cloud`.
2. Abre el archivo `README.md`.
3. Pulsa el icono del lápiz **Edit this file**.
4. Al final del archivo añade esta línea:

   ```html
   <!-- Activar primer despliegue de Cloudflare -->
   ```

5. Pulsa **Commit changes**.
6. Mantén la opción de guardar directamente en la rama `main`.
7. Confirma de nuevo con **Commit changes**.

Este comentario no cambia cómo funciona ni cómo se ve la aplicación. Su único objetivo es crear el primer cambio que Cloudflare detectará. Los cambios futuros en `main` también iniciarán un despliegue automático.

### Paso 6.7 — Esperar y comprobar el despliegue

1. Vuelve a `Workers & Pages → woffu-clock-cloud → Deployments`.
2. Abre **View build history** si aparece.
3. Espera a que termine el build de `main`.
4. Abre el detalle si Cloudflare muestra un error.

El resultado correcto debe indicar **Success**, **Succeeded** o un estado verde equivalente. El Worker definitivo habrá sustituido al “Hello World”.

### Qué ocurre durante este primer despliegue

El repositorio ya contiene:

- El código de la aplicación.
- El comando y la versión de Wrangler.
- El cron `* * * * *`, que se ejecuta cada minuto.
- Un binding D1 llamado `DB`.
- La configuración para conservar variables del panel en futuros despliegues.

Como el binding D1 está declarado sin un identificador fijo, Wrangler puede crear automáticamente una base independiente para tu Worker. Cloudflare documenta este comportamiento como **Automatic provisioning**:

[Cloudflare Docs — Aprovisionamiento automático de recursos](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)

Cloudflare todavía identifica este aprovisionamiento automático como **Beta**. Por eso el apartado siguiente obliga a comprobar el binding y ofrece una alternativa manual. No ejecutes SQL: la aplicación crea sus propias tablas al abrirse por primera vez.

---

## 7. Comprobar la base de datos D1

D1 guarda la configuración y los registros de tu copia. No contiene las contraseñas de Woffu: esas se guardarán aparte como secretos del Worker.

### Paso 7.1 — Comprobar el binding

1. En **Workers & Pages**, abre `woffu-clock-cloud`.
2. Entra en **Bindings**. En algunas versiones del panel está dentro de **Settings**.
3. Busca una conexión de tipo **D1 database**.
4. Confirma que el nombre de variable o binding es exactamente:

```text
DB
```

### Paso 7.2 — Comprobar que existe la base

También puedes abrir la sección **D1 SQL database** de Cloudflare. Deberías ver una base asociada al Worker. El nombre exacto puede haber sido generado automáticamente.

Documentación oficial:

[Cloudflare Docs — Crear y conectar una base D1](https://developers.cloudflare.com/d1/get-started/)

### Solo si Cloudflare no la ha creado automáticamente

Haz esta alternativa únicamente si el despliegue terminó pero no existe ningún binding `DB`:

1. Abre **D1 SQL database** en Cloudflare.
2. Pulsa **Create database**.
3. Pon un nombre sencillo, por ejemplo `woffu-clock-db-tu-nombre`.
4. Vuelve a `Workers & Pages → woffu-clock-cloud → Bindings`.
5. Pulsa **Add binding**.
6. Elige **D1 database**.
7. En **Variable name**, escribe exactamente `DB`.
8. Selecciona la base que acabas de crear.
9. Guarda y despliega la nueva versión si Cloudflare lo solicita.

No cambies `DB` por el nombre de la base. `DB` es el nombre que utiliza el código para encontrarla.

---

## 8. Configurar contraseñas y modo seguro

Ya añadiste estos valores antes de conectar GitHub, porque el repositorio declara los tres secretos como obligatorios para desplegar. Esta sección sirve para revisarlos y entender qué controla cada uno.

Todos deben ser valores de **ejecución** del Worker. No los añadas únicamente en **Build variables and secrets**, porque esos valores solo existen durante el build y la aplicación no podría leerlos cuando está funcionando.

La ruta habitual es:

```text
Workers & Pages
→ woffu-clock-cloud
→ Settings
→ Variables and Secrets
```

Guía oficial:

[Cloudflare Docs — Variables y secretos](https://developers.cloudflare.com/workers/configuration/environment-variables/#add-environment-variables-via-the-dashboard)

### Paso 8.1 — Revisar los tres secretos

Confirma que existen estos valores con tipo **Secret**. Si falta alguno, pulsa **Add** y créalo:

| Nombre exacto | Contenido | Para qué sirve |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Una contraseña nueva y exclusiva. | Protege el acceso a la webapp. |
| `WOFFU_EMAIL` | Email de la cuenta Woffu de prueba. | Permite iniciar sesión en Woffu. |
| `WOFFU_PASSWORD` | Contraseña de esa cuenta Woffu. | Permite iniciar sesión en Woffu. |

Respeta mayúsculas, guiones bajos y nombres exactos.

Cloudflare ocultará el contenido de un secreto después de guardarlo. Si más adelante no recuerdas qué valor pusiste, tendrás que reemplazarlo por uno nuevo.

### Paso 8.2 — Revisar las dos variables de seguridad

Confirma que existen estos valores con tipo **Text** o **Plaintext**:

| Nombre exacto | Valor inicial exacto |
| --- | --- |
| `MODE` | `TEST` |
| `WOFFU_WRITE_ENABLED` | `false` |

### Paso 8.3 — Aplicar los cambios

1. Revisa los cinco nombres.
2. Pulsa **Deploy**, **Save and Deploy** o el botón equivalente.
3. Espera a que Cloudflare confirme la nueva versión.

### Qué significan los dos valores iniciales

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
```

Es la configuración segura. El plan y el scheduler pueden probarse, pero no se envía ningún fichaje a Woffu.

### Los tres controles de escritura

Un fichaje **programado** solo puede salir cuando coinciden estas tres condiciones:

| Control | Dónde se cambia | Valor que permite el fichaje programado |
| --- | --- | --- |
| Modo | Cloudflare | `MODE = LIVE` |
| Permiso técnico de escritura | Cloudflare | `WOFFU_WRITE_ENABLED = true` |
| Interruptor de automatización | Webapp | `Automatización = Activa` |

La página manual `/woffu/punch` necesita los dos controles de Cloudflare, pero no depende del interruptor de automatización de la webapp.

---

## 9. Encontrar y abrir la dirección de la webapp

### Paso 9.1 — Copiar la dirección

1. Abre `Workers & Pages → woffu-clock-cloud`.
2. Busca **Domains & Routes**, **Visit**, **workers.dev** o la URL del despliegue activo.
3. Copia la dirección de producción, parecida a:

```text
https://woffu-clock-cloud.TU-SUBDOMINIO.workers.dev
```

En esta guía la llamaremos:

```text
TU_URL
```

Cuando veas `TU_URL/health`, debes sustituir solo `TU_URL` por tu dirección real. No escribas literalmente `TU_URL` en el navegador.

### Paso 9.2 — Abrir la webapp

Abre `TU_URL/`.

El navegador mostrará una pequeña ventana de usuario y contraseña. Introduce:

```text
Usuario: admin
Contraseña: el valor que guardaste en ADMIN_PASSWORD
```

El usuario siempre es `admin`. No es tu usuario de GitHub, Cloudflare ni Woffu.

### Qué ocurre la primera vez

Al cargar los datos, la aplicación crea automáticamente en D1 las tablas que necesita. No hace falta importar una base ni ejecutar scripts.

La automatización comienza en estado **Pausada** por defecto, aunque el cron de Cloudflare ya exista.

---

## 10. Hacer las primeras comprobaciones sin fichar

Mantén durante toda esta sección:

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
Automatización = Pausada
```

### Comprobación 10.1 — Estado técnico

Abre:

```text
TU_URL/health
```

Deberías ver un resultado parecido a:

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

Significado:

- `ok: true`: el Worker responde.
- `mode: "TEST"`: está en simulación.
- `woffuCredentialsConfigured: true`: Cloudflare encuentra email y contraseña de Woffu. No significa todavía que sean correctos.
- `woffuWriteEnabled: false`: el permiso técnico de escritura está cerrado.
- `liveManualPunchReady: false`: la página de fichaje manual no puede escribir.
- `scheduledWoffuWritesEnabled: false`: la puerta técnica del scheduler está cerrada.

> `/health` es un diagnóstico público y no pide la contraseña de administración. No muestra tus secretos. Además, `scheduledWoffuWritesEnabled` refleja solo los dos controles de Cloudflare; para una ejecución programada también debe aparecer **Activa** dentro de la webapp.

### Comprobación 10.2 — Acceso a la webapp

Abre:

```text
TU_URL/
```

Confirma que:

- Acepta el usuario `admin` y tu `ADMIN_PASSWORD`.
- Aparece **Woffu Clock**.
- El estado inicial es **Pausada**.
- Aparece el aviso **Modo TEST**.
- Ves las pestañas **Resumen**, **Vacaciones**, **Manual** y **Ajustes**.

### Comprobación 10.3 — Conexión de lectura con Woffu

Abre:

```text
TU_URL/api/woffu/test
```

Puede volver a pedir el usuario `admin` y la contraseña de administración. Esta URL:

1. Inicia sesión en Woffu con los secretos.
2. Obtiene el identificador del usuario y de la empresa.
3. Consulta el dominio Woffu de la empresa.
4. No crea ningún fichaje.

El resultado correcto contiene:

```json
{
  "ok": true,
  "connection": "success",
  "message": "Autenticación y lecturas verificadas. No se ha creado ningún fichaje."
}
```

Los identificadores aparecen parcialmente ocultos.

Si esta comprobación falla, no actives `LIVE`. Ve a [Solución de problemas](#17-solución-de-problemas).

---

## 11. Cómo se usa la webapp

La webapp tiene cuatro secciones. En móvil aparecen abajo; en una pantalla grande aparecen en el menú lateral.

### 11.1 Resumen

Es la pantalla principal. Muestra:

- Si la automatización está **Activa** o **Pausada**.
- El total semanal previsto.
- El objetivo semanal.
- Los días laborables de la semana actual.
- Las cuatro marcas exactas de cada día, incluidos los segundos.
- Vacaciones, pausas y ajustes manuales.

Los botones principales son:

- **Activar/Pausar:** cambia el interruptor interno del scheduler.
- **Regenerar semana:** sustituye el plan aleatorio de la semana actual por uno nuevo.
- **Gestionar este día:** abre ese día en la sección Manual.

No pulses repetidamente **Regenerar semana** cuando la automatización real esté activa. Revisa siempre el nuevo horario antes de dejarla funcionando.

### 11.2 Cómo se genera el horario

El horario base tiene cuatro momentos:

1. Entrada mañana.
2. Salida mediodía.
3. Entrada mediodía.
4. Salida tarde.

La configuración debe cumplir:

- Las cuatro horas están en orden cronológico.
- El descanso de mediodía dura al menos una hora.
- El horario base suma exactamente ocho horas de trabajo.

Al generar el plan:

- Cada marca recibe un retraso aleatorio de `0` a `4 minutos y 59 segundos` respecto a su hora base.
- Cada día puede desviarse hasta tres minutos del objetivo diario.
- Las desviaciones se compensan para que el total semanal previsto conserve el objetivo de ocho horas por día laborable.
- Un día de vacaciones no genera marcas y reduce el objetivo semanal en ocho horas.
- La zona horaria usada por la aplicación es `Europe/Madrid`.

Ejemplo: si la entrada base es `09:00`, una entrada planificada podría ser `09:03:27`.

### 11.3 Vacaciones

En **Vacaciones**:

1. Usa las flechas para cambiar de mes.
2. Pulsa un día laborable para seleccionarlo o quitarlo.
3. Los fines de semana están deshabilitados.
4. Pulsa **Guardar**.

Al guardar, la aplicación recalcula los planes de las semanas afectadas. Un día marcado como vacaciones:

- No genera fichajes automáticos.
- No cuenta en el objetivo semanal.
- No admite marcas manuales desde la pantalla Manual.

### 11.4 Manual

Esta sección permite coordinar acciones que vas a realizar tú directamente.

#### Pausar parcialmente un día

Puedes elegir desde qué evento quieres hacerte cargo manualmente. Por ejemplo, si eliges **Entrada mediodía**:

- Las marcas anteriores pueden seguir automáticas.
- **Entrada mediodía** y **Salida tarde** quedan omitidas por el scheduler.

Pulsa **Reanudar este día** para eliminar esa pausa.

#### Registrar una marca manual

Selecciona evento y hora real, y pulsa **Guardar marca manual**. La hora aparece en azul en el resumen.

> **Muy importante:** este botón no envía ningún fichaje a Woffu. Solo guarda en D1 que ese evento ya ha sido gestionado manualmente y hace que el scheduler no lo repita. Debes realizar el fichaje real en Woffu o mediante `TU_URL/woffu/punch` y después registrar el ajuste en esta pantalla si corresponde a un evento del plan.

La aplicación comprueba que las horas efectivas mantengan el orden y un descanso mínimo de una hora.

### 11.5 Ajustes

En **Ajustes** encontrarás:

- **Horario base:** las cuatro horas usadas para generar semanas.
- **Automatización:** el interruptor global Activa/Pausada.
- **Diagnóstico:** versión, modo y momento de actualización.
- **Últimas ejecuciones:** resultados guardados por el scheduler.

Guardar un nuevo horario base invalida los planes generados anteriormente para poder recrearlos con la nueva configuración.

### 11.6 Significado de los estados del registro

| Estado | Significado |
| --- | --- |
| `TEST` | El evento llegó a su hora en modo de prueba; no se envió a Woffu. |
| `SUCCESS` | Woffu aceptó el fichaje programado. |
| `FAILED` | Se intentó el fichaje, pero ocurrió un error. Revisa el mensaje antes de hacer nada manualmente para evitar duplicados. |
| `PENDING` | El evento empezó a procesarse y todavía no tiene resultado final. |

---

## 12. Probar el plan automático sin escribir en Woffu

Esta es la prueba recomendada antes de cualquier escritura real.

### Paso 12.1 — Confirmar el modo seguro

Abre `TU_URL/health` y confirma:

```text
mode: TEST
woffuWriteEnabled: false
```

### Paso 12.2 — Configurar el horario

1. Entra en `TU_URL/`.
2. Abre **Ajustes**.
3. Introduce cuatro horas que sumen ocho horas de trabajo y dejen al menos una hora de descanso.
4. Pulsa **Guardar horario**.

Ejemplo válido:

```text
Entrada mañana:   09:00
Salida mediodía:  13:00
Entrada mediodía: 14:00
Salida tarde:     18:00
```

### Paso 12.3 — Preparar una prueba cercana

Si quieres ver el scheduler sin esperar hasta el día siguiente:

1. Espera a que hayan pasado al menos 15 minutos desde el primer despliegue del Worker. Los cambios de un Cron Trigger pueden tardar unos minutos en propagarse.
2. Ajusta una de las horas base a un momento futuro razonablemente cercano.
3. Mantén las reglas de ocho horas y una hora de descanso.
4. Guarda el horario.
5. En **Resumen**, pulsa **Regenerar semana**.
6. Anota la hora exacta generada para el siguiente evento.

Cloudflare documenta que los cambios de cron pueden tardar hasta 15 minutos en propagarse:

[Cloudflare Docs — Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

### Paso 12.4 — Activar solo la simulación

1. Pulsa **Activar** en la webapp.
2. Espera a que pase la hora exacta planificada.
3. Abre **Ajustes → Últimas ejecuciones**.
4. Debe aparecer `TEST`.
5. Comprueba en Woffu que no se creó ningún fichaje.
6. Pulsa **Pausar** cuando termines la prueba.

El cron se ejecuta una vez por minuto y, en modo TEST, registra la simulación sin comunicarse con el endpoint de fichaje de Woffu.

---

## 13. Probar un único fichaje real de forma controlada

Haz esta sección únicamente con una cuenta Woffu de prueba autorizada y después de que `/api/woffu/test` haya respondido correctamente.

### Paso 13.1 — Mantener el scheduler pausado

En la webapp confirma:

```text
Automatización = Pausada
```

Esto evita que el plan semanal envíe marcas mientras pruebas la página manual.

### Paso 13.2 — Abrir temporalmente la escritura

En Cloudflare abre:

```text
Workers & Pages
→ woffu-clock-cloud
→ Settings
→ Variables and Secrets
```

Cambia las variables de texto a:

```text
MODE = LIVE
WOFFU_WRITE_ENABLED = true
```

Guarda y despliega los cambios.

### Paso 13.3 — Comprobar la puerta técnica

Abre `TU_URL/health` y confirma:

```text
mode: LIVE
woffuWriteEnabled: true
liveManualPunchReady: true
```

### Paso 13.4 — Enviar una única marca

Abre:

```text
TU_URL/woffu/punch
```

1. Identifícate con `admin` y `ADMIN_PASSWORD` si el navegador lo pide.
2. Lee el estado de la página.
3. Pulsa **Fichar ahora** una sola vez.
4. Espera al mensaje de confirmación.
5. Abre [Woffu](https://app.woffu.com/) y confirma que existe exactamente una nueva marca con la hora actual.

Esta acción usa la hora real del momento. No utiliza la hora aleatoria del plan semanal y no depende de que la automatización esté activa.

### Paso 13.5 — Cerrar otra vez la escritura

Si todavía no vas a probar el scheduler real, vuelve a Cloudflare y deja:

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
```

Guarda y despliega.

---

## 14. Activar la automatización real

Antes de activarla, revisa:

- La cuenta Woffu es la cuenta de prueba correcta.
- `/api/woffu/test` funciona.
- El fichaje manual controlado funcionó.
- El plan de la semana muestra las horas esperadas.
- Las vacaciones son correctas.
- No hay pausas o marcas manuales olvidadas.
- Entiendes cómo detener la automatización.

### Secuencia recomendada

1. Mantén la webapp en **Pausada**.
2. En Cloudflare configura:

   ```text
   MODE = LIVE
   WOFFU_WRITE_ENABLED = true
   ```

3. Guarda y despliega.
4. Abre `TU_URL/health`.
5. Confirma `mode: LIVE`, `woffuWriteEnabled: true` y `scheduledWoffuWritesEnabled: true`.
6. Vuelve a la webapp y revisa por última vez la siguiente hora planificada.
7. Pulsa **Activar** como último paso.

### Qué hace el scheduler en cada minuto

Cuando la automatización está activa:

```text
Cloudflare despierta el Worker
→ usa la fecha y hora de Europe/Madrid
→ ignora sábados y domingos
→ comprueba si el día es vacaciones
→ carga el plan del día
→ aplica pausas y marcas manuales
→ busca un evento dentro de ese minuto
→ evita repetir un evento ya completado
→ inicia sesión en Woffu
→ envía la marca con la hora exacta planificada
→ guarda SUCCESS o FAILED en D1
```

La aplicación genera las semanas siguientes cuando el scheduler o la webapp las necesita. No existe una fecha de finalización automática.

### Después del primer evento programado

1. Comprueba la marca en Woffu.
2. Abre **Ajustes → Últimas ejecuciones**.
3. Confirma que aparece `SUCCESS`.
4. Si aparece `FAILED`, pausa la automatización antes de hacer una marca manual y revisa el error.

---

## 15. Detener la automatización

Cerrar el navegador o apagar el ordenador **no** detiene Cloudflare.

### Parada rápida desde la webapp

En `TU_URL/` pulsa **Pausar**.

Esto detiene los fichajes programados, pero la página `TU_URL/woffu/punch` todavía podría fichar si `MODE=LIVE` y `WOFFU_WRITE_ENABLED=true`.

### Bloqueo técnico desde Cloudflare

En **Variables and Secrets** cambia:

```text
WOFFU_WRITE_ENABLED = false
```

Guarda y despliega. Con este valor, ni el scheduler real ni la página manual pueden escribir en Woffu.

### Estado recomendado al terminar las pruebas

Deja los tres controles así:

```text
MODE = TEST
WOFFU_WRITE_ENABLED = false
Automatización = Pausada
```

Comprueba `TU_URL/health` después de guardar.

### Si has perdido acceso a la webapp

Aunque no recuerdes `ADMIN_PASSWORD`, puedes bloquear escrituras desde Cloudflare poniendo `WOFFU_WRITE_ENABLED = false`. También puedes reemplazar `ADMIN_PASSWORD` por un secreto nuevo.

---

## 16. Actualizar la webapp en el futuro

Tu fork no siempre incorpora automáticamente los cambios del repositorio original.

### Actualización sencilla desde GitHub

1. Abre `https://github.com/TU-USUARIO/woffu-clock-cloud`.
2. Busca el botón **Sync fork**.
3. Revisa el aviso.
4. Pulsa **Update branch**.

Guía oficial:

[GitHub Docs — Sincronizar un fork desde la web](https://docs.github.com/es/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork)

Al actualizar la rama `main`, Cloudflare inicia automáticamente un nuevo build.

### Después de actualizar

1. Abre `Workers & Pages → woffu-clock-cloud → Deployments`.
2. Espera a que el build termine correctamente.
3. Comprueba `TU_URL/health`.
4. Entra en la webapp y revisa el modo, el plan y el estado Activa/Pausada.

Las variables del panel se conservan porque el proyecto usa `keep_vars: true`, y Cloudflare tampoco elimina secretos durante un despliegue normal. La base D1 conserva su información mientras siga asociada al Worker.

> Sincronizar el fork puede desplegar código nuevo. Hazlo cuando puedas revisar el resultado y deja la automatización pausada si el cambio todavía no ha sido probado.

---

## 17. Solución de problemas

### “No encuentro el repositorio” o GitHub muestra 404

Posibles causas:

- No has iniciado sesión en la cuenta correcta.
- No has aceptado la invitación a un repositorio privado.
- El propietario no ha permitido forks privados.

Solución: confirma tu usuario con el propietario del repositorio, acepta la invitación y vuelve a abrir el enlace original.

### El fork no aparece en Cloudflare

1. Abre [GitHub → Aplicaciones instaladas](https://github.com/settings/installations).
2. Entra en **Cloudflare Workers and Pages**.
3. Comprueba que tu fork está autorizado.
4. Vuelve a Cloudflare y recarga la lista.

### El build indica que faltan secretos obligatorios

El código todavía no se ha desplegado porque falta uno de estos secretos de ejecución:

```text
ADMIN_PASSWORD
WOFFU_EMAIL
WOFFU_PASSWORD
```

1. Abre el Worker vacío `woffu-clock-cloud`.
2. Ve a **Settings → Variables and Secrets**.
3. Crea o reemplaza los tres valores con tipo **Secret**.
4. Vuelve a **Deployments → View build history**.
5. Abre el build fallido y pulsa **Retry build**.

No pongas las contraseñas en el repositorio para resolver este error.

### El build falla porque el nombre no coincide

El Worker debe llamarse exactamente:

```text
woffu-clock-cloud
```

Ese nombre coincide con `wrangler.jsonc`. Corrige el nombre del proyecto o vuelve a importar el repositorio con el nombre correcto.

### El build falla por un comando

Comprueba:

```text
Rama: main
Directorio raíz: vacío o /
Build command: vacío
Deploy command: npx wrangler deploy
```

Después pulsa **Retry deployment** o el botón equivalente.

### La web muestra un error relacionado con `DB`

Comprueba en **Bindings**:

- Tipo: D1 database.
- Variable name: `DB`.
- Base seleccionada: la D1 de tu copia.

Si no existe, sigue la alternativa del [apartado 7](#7-comprobar-la-base-de-datos-d1).

### La base existe pero no veo tablas

Abre `TU_URL/`, identifícate y espera a que cargue el resumen. Las tablas se crean durante la primera carga de datos o ejecución del scheduler. No necesitas ejecutar SQL.

### `/health` muestra `woffuCredentialsConfigured: false`

Falta `WOFFU_EMAIL`, `WOFFU_PASSWORD` o alguno está vacío.

1. Ve a **Settings → Variables and Secrets** del Worker.
2. Confirma que ambos están en las variables de ejecución, no solo en las variables de build.
3. Reemplaza los secretos si hay dudas.
4. Despliega y vuelve a abrir `/health`.

### El navegador pide la contraseña una y otra vez

Comprueba:

```text
Usuario: admin
Contraseña: ADMIN_PASSWORD, no la contraseña de Woffu
```

Los navegadores suelen recordar credenciales incorrectas de autenticación básica. Prueba una ventana privada después de confirmar o reemplazar `ADMIN_PASSWORD` en Cloudflare.

### `/api/woffu/test` falla

No actives escrituras. Revisa:

- Email Woffu correcto y sin espacios al principio o final.
- Contraseña Woffu actual.
- Cuenta de prueba activa.
- Inicio de sesión con contraseña permitido por la configuración de la empresa.
- Permisos de la cuenta para consultar usuario y empresa.

Prueba primero a iniciar sesión manualmente en [Woffu](https://app.woffu.com/). Si la organización utiliza exclusivamente SSO o restringe la API, consulta con su administrador.

### `/woffu/punch` dice “Escritura real desactivada”

Es el comportamiento seguro. Para la prueba controlada deben coincidir:

```text
MODE = LIVE
WOFFU_WRITE_ENABLED = true
```

Guarda, despliega y confirma `/health`. Vuelve a `TEST` y `false` al terminar.

### El scheduler no ejecuta un evento

Revisa en este orden:

1. La webapp muestra **Activa**.
2. `/health` muestra `mode: LIVE` y `woffuWriteEnabled: true`.
3. El día es de lunes a viernes.
4. El día no está marcado como vacaciones.
5. El evento no está cubierto por una pausa parcial.
6. El evento no está registrado como manual.
7. La hora exacta del plan todavía no ha pasado.
8. El cron `* * * * *` aparece en **Settings → Triggers → Cron Triggers**.
9. Han pasado hasta 15 minutos desde un cambio reciente del cron.

### El registro muestra `TEST` cuando esperabas `SUCCESS`

`MODE` sigue en `TEST` en la versión desplegada. Revisa las variables de ejecución y `/health`.

### El registro muestra `FAILED`

1. Pausa la automatización.
2. Lee el mensaje en **Ajustes → Últimas ejecuciones**.
3. Comprueba Woffu antes de repetir manualmente para evitar duplicados.
4. Abre `Workers & Pages → woffu-clock-cloud → Observability` para consultar los logs de Cloudflare.

Guía oficial:

[Cloudflare Docs — Consultar Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

### GitHub está actualizado pero Cloudflare no ha desplegado

1. Abre **Deployments** en el Worker.
2. Revisa el último build y sus logs.
3. En **Settings → Builds**, confirma repositorio, rama `main` y comando de deploy.
4. Comprueba los permisos de la aplicación de Cloudflare en GitHub.

Estado de los servicios, por si existe una incidencia general:

- [Estado de GitHub](https://www.githubstatus.com/)
- [Estado de Cloudflare](https://www.cloudflarestatus.com/)

---

## 18. Preguntas frecuentes

### ¿Tengo que dejar el ordenador encendido?

No. Cloudflare ejecuta el Worker y el cron en la nube.

### ¿Cerrar la webapp detiene los fichajes?

No. Debes pulsar **Pausar** o poner `WOFFU_WRITE_ENABLED = false`.

### ¿Necesito Git, Node.js, Visual Studio Code o terminal?

No para este tutorial. GitHub y Cloudflare se conectan desde el navegador.

### ¿Necesito comprar un dominio?

No. La dirección `workers.dev` es suficiente para este entorno de prueba.

### ¿Cuesta dinero?

Cloudflare ofrece niveles gratuitos con límites para Workers y D1. Una copia de prueba de poco uso está planteada para funcionar dentro de esos niveles, pero debes revisar el consumo y las condiciones actuales de tu cuenta. No actives voluntariamente un plan de pago si no lo necesitas.

### ¿Dónde se guardan mis datos?

- El código está en tu fork de GitHub.
- Horarios, vacaciones, planes, pausas y registros están en tu D1.
- Las credenciales están en los secretos del Worker.
- La webapp puede guardar una copia temporal de su última vista en el almacenamiento local del navegador para cargar más rápido.

### ¿Quién puede abrir la dirección?

La dirección `workers.dev` existe en Internet. La webapp y sus APIs de gestión piden `admin` y `ADMIN_PASSWORD`, pero `/health` es público y muestra solo estado técnico no sensible. No compartas la URL ni la contraseña.

### ¿“Registrar marca manual” ficha en Woffu?

No. Solo registra un ajuste en D1 y evita que el scheduler duplique ese evento. El fichaje real debe hacerse en Woffu o en `TU_URL/woffu/punch` cuando las escrituras estén habilitadas.

### ¿La automatización termina el viernes o al acabar la semana?

No. Es indefinida. Ignora fines de semana, genera las semanas que necesita y continúa hasta que la pauses o cierres la escritura.

### ¿Borrar el fork de GitHub detiene Cloudflare?

No necesariamente. Un despliegue ya publicado puede seguir funcionando. Detén primero la automatización en la webapp y bloquea la escritura en Cloudflare.

### ¿Puedo usar una cuenta Woffu real?

Esta guía y el proyecto están planteados para pruebas. No uses una cuenta laboral real sin autorización expresa, una revisión funcional y de seguridad, y una comprobación de las políticas aplicables.

---

## 19. Checklist final

### Cuentas y despliegue

- [ ] He creado y verificado mi cuenta de GitHub.
- [ ] Mi fork está en `TU-USUARIO/woffu-clock-cloud`.
- [ ] He creado y verificado mi cuenta de Cloudflare.
- [ ] Cloudflare está conectado a mi fork, no al repositorio de otra persona.
- [ ] El Worker se llama exactamente `woffu-clock-cloud`.
- [ ] El último deployment aparece correcto.
- [ ] Existe una base D1 conectada con el binding exacto `DB`.

### Seguridad

- [ ] `ADMIN_PASSWORD`, `WOFFU_EMAIL` y `WOFFU_PASSWORD` son secretos de ejecución.
- [ ] No he escrito ninguna contraseña en GitHub ni en el código.
- [ ] Mi contraseña de administración es única.
- [ ] Estoy utilizando una cuenta Woffu de prueba autorizada.

### Pruebas sin escritura

- [ ] `MODE = TEST`.
- [ ] `WOFFU_WRITE_ENABLED = false`.
- [ ] La automatización está pausada al empezar.
- [ ] `/health` responde con `ok: true`.
- [ ] `/api/woffu/test` responde correctamente.
- [ ] Entiendo las cuatro pantallas de la webapp.
- [ ] He visto un evento `TEST` sin que aparezca un fichaje en Woffu.

### Antes de una prueba real

- [ ] He probado una única marca mediante `/woffu/punch` con el scheduler pausado.
- [ ] He comprobado el resultado directamente en Woffu.
- [ ] He revisado el plan semanal, vacaciones, pausas y marcas manuales.
- [ ] Sé que necesito `LIVE`, escritura `true` y automatización activa para el scheduler real.
- [ ] Sé cómo pausar la webapp y cómo poner `WOFFU_WRITE_ENABLED = false`.

### Al terminar

- [ ] He dejado `MODE = TEST`.
- [ ] He dejado `WOFFU_WRITE_ENABLED = false`.
- [ ] He dejado la automatización en **Pausada**.
- [ ] He comprobado el estado final en `/health` y en la webapp.

Con todos los puntos correspondientes verificados, la copia está configurada y sabes cómo usarla, comprobarla y detenerla de forma segura.
