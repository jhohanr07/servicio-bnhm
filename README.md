# Sistema de tickets de servicio técnico – BNH Medical

Versión para **Vercel**. Los datos siguen en tu Google Sheet (`Sistema_Tickets_Servicio_Tecnico`).
Como tu organización no permite crear claves de cuenta de servicio, Vercel **no usa ninguna clave de Google**:
habla con un pequeño *puente* de Apps Script (`apps-script/Backend.gs`) pegado en el propio Sheet, que lee y
escribe las hojas y envía los correos. Vercel solo conoce la dirección del puente y una clave secreta.

```
Navegador ──> Vercel (páginas + reglas del sistema) ──HTTPS + API_SECRET──> Apps Script (en tu Sheet) ──> Hojas y correo
```

| Dirección | Qué es |
|---|---|
| `/` | Formulario del cliente (reportar falla) |
| `/panel` | Panel de casos (pide la clave) |
| `/dashboard` | Dashboard (misma clave) |
| `/tecnico?id=…&t=…` | Página del técnico; se abre desde el botón "Abrir Ticket" del correo |

## Estructura

```
apps-script/   Backend.gs y appsscript.json  (se pegan en el Sheet, NO se despliegan en Vercel)
public/        index.html, dashboard.html, tecnico.html
api/rpc.js     las páginas llaman aquí
api/cron-alertas.js   revisión automática de casos sin respuesta (Vercel Cron)
lib/           core.js (reglas del sistema), puente.js, sheets.js, mail.js, util.js
test/prueba.js prueba de extremo a extremo con un libro simulado:  npm test
```

## 1. Puente de Apps Script (una sola vez)

1. Abre el Google Sheet > **Extensiones > Apps Script**.
2. Crea el archivo `Backend.gs` (o reemplaza `Code.gs`) y pega el contenido de `apps-script/Backend.gs`.
   Si el proyecto ya tenía el `Code.gs` anterior del sistema de tickets, bórralo: ya no se usa. Borra también los archivos HTML del proyecto.
3. (Recomendado) **Configuración del proyecto** > marca "Mostrar el archivo de manifiesto appsscript.json" y pega `apps-script/appsscript.json` (zona horaria Caracas y permisos).
4. **Configuración del proyecto > Propiedades del script > Agregar propiedad**: `API_SECRET` = un texto largo y aleatorio (guárdalo, lo usarás en Vercel).
5. En el editor elige la función `probarPuente` > **Ejecutar** y acepta los permisos. En el registro debe decir "Hojas que faltan: ninguna" y "API_SECRET definida: sí".
6. **Implementar > Nueva implementación > Aplicación web**: *Ejecutar como*: **Yo**; *Quién tiene acceso*: **Cualquier persona**. Copia la URL que termina en `/exec` (será `APPS_SCRIPT_URL`).
   Abrirla en el navegador debe mostrar `{"ok":true,"mensaje":"Puente de tickets activo."}`.

Los correos salen desde la cuenta que implementó el puente (los límites diarios de envío son los de esa cuenta).
Cuando cambies `Backend.gs`, crea una **nueva versión** de la implementación.

El libro debe tener las hojas `TICKETS`, `TECNICOS`, `ESTADOS`, `DATA CLIENTE` y `Sales` con los mismos encabezados de siempre.
Si falta la columna **Última alerta** en TICKETS, el sistema la crea solo.

## 2. Subir a GitHub

```bash
git init
git add .
git commit -m "Sistema de tickets de servicio técnico"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/NOMBRE_DEL_REPO.git
git push -u origin main
```

(Crea antes el repositorio vacío en github.com > New repository. `.env` está en `.gitignore`: las claves nunca se suben.)

## 3. Desplegar en Vercel

1. vercel.com > **Add New > Project** > importa el repositorio. Framework: **Other**. No hace falta comando de build.
2. En **Settings > Environment Variables** crea: `APPS_SCRIPT_URL`, `API_SECRET` (igual que en Apps Script),
   `CLAVE_PANEL`, `TOKEN_SECRET`, `CRON_SECRET` y, si quieres, `CORREO_ADMIN`.
3. **Deploy**. Después de cambiar variables, haz Redeploy.

## Alertas automáticas

`vercel.json` programa una revisión **una vez al día (8:00 a. m. hora de Caracas)**. Avisa por correo de los casos sin
fecha de atención con más de 72 h y repite cada 24 h. El plan gratuito de Vercel solo permite una ejecución diaria;
con el plan Pro puedes cambiar `"0 12 * * *"` por `"*/15 * * * *"` (y poner `ALERTAS_CADA_MINUTOS=15`).
El botón "Enviar alertas ahora" del dashboard sigue funcionando.

## Seguridad

- Quien conozca la URL del puente **y** `API_SECRET` puede leer y escribir el libro: no los compartas ni los subas a GitHub.
- Si sospechas que se filtraron, cambia `API_SECRET` en Apps Script y en Vercel.
- Si tu administrador de Google no permite aplicaciones web con acceso "Cualquier persona", pídele que lo habilite para este proyecto
  o usa *Workload Identity Federation* con Vercel (alternativa sin claves; requiere que el administrador cree el proveedor de identidad).

## Diferencias respecto al sistema anterior de Apps Script

- Las alertas corren en Vercel Cron (ver arriba) y ya no hay menú "Servicio técnico" en el Sheet.
- La caché de clientes y equipos dura 30 minutos por instancia.
- Los enlaces "Abrir Ticket" de correos enviados con el sistema anterior dejan de funcionar: el token ahora se firma con `TOKEN_SECRET`.
