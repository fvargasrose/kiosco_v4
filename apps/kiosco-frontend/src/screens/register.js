/**
 * Pantalla de registro de paciente nuevo.
 *
 * - Formulario único con scroll vertical.
 * - Teclado nativo del dispositivo (web): el teclado táctil del kiosco se retiró.
 * - Campos con doble caja: cédula, celular, email.
 * - Fecha de nacimiento: tres selectores (DD / MM / AAAA).
 * - Sexo: radio buttons.
 * - Al registrarse → navega a login-cedula con los parámetros de Habeas Data.
 */

import { api, ApiError } from '../api.js';
import { toast } from '../components/toast.js';

const MONTHS = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];

export function renderRegister(container, params, navigate) {
  const { policyVersion, policyHash } = params || {};

  if (!policyVersion || !policyHash) {
    navigate('habeas-data');
    return null;
  }

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Registro de paciente nuevo</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">← Volver</button>
      </header>
      <div class="screen-body register-body" id="register-form">

        <div id="form-error" class="alert alert-error" style="display:none"></div>

        <!-- ──────────────── IDENTIDAD ──────────────── -->
        <div class="register-section">
          <h2 class="register-section-title">Identificación</h2>

          <div class="form-group">
            <label for="cedula">Cédula de ciudadanía <span class="required">*</span></label>
            <input type="text" id="cedula" class="form-control form-control-lg"
                   inputmode="numeric" maxlength="15" autocomplete="off"
                   placeholder="Solo números" data-kb="numeric">
          </div>
          <div class="form-group">
            <label for="cedula_confirm">Confirma tu cédula <span class="required">*</span></label>
            <input type="text" id="cedula_confirm" class="form-control form-control-lg"
                   inputmode="numeric" maxlength="15" autocomplete="off"
                   placeholder="Repite tu cédula" data-kb="numeric">
            <div class="field-error" id="cedula_confirm-err"></div>
          </div>

          <div class="form-group">
            <label for="celular">Celular (sin +57) <span class="required">*</span></label>
            <input type="text" id="celular" class="form-control form-control-lg"
                   inputmode="numeric" maxlength="10" autocomplete="off"
                   placeholder="3001234567" data-kb="numeric">
          </div>
          <div class="form-group">
            <label for="celular_confirm">Confirma tu celular <span class="required">*</span></label>
            <input type="text" id="celular_confirm" class="form-control form-control-lg"
                   inputmode="numeric" maxlength="10" autocomplete="off"
                   placeholder="Repite tu celular" data-kb="numeric">
            <div class="field-error" id="celular_confirm-err"></div>
          </div>

          <div class="form-group">
            <label for="email">Correo electrónico <span class="required">*</span></label>
            <input type="email" id="email" class="form-control form-control-lg"
                   autocomplete="off" placeholder="tucorreo@ejemplo.com" data-kb="alpha">
          </div>
          <div class="form-group">
            <label for="email_confirm">Confirma tu correo <span class="required">*</span></label>
            <input type="email" id="email_confirm" class="form-control form-control-lg"
                   autocomplete="off" placeholder="Repite tu correo" data-kb="alpha">
            <div class="field-error" id="email_confirm-err"></div>
          </div>
        </div>

        <!-- ──────────────── DATOS PERSONALES ──────────────── -->
        <div class="register-section">
          <h2 class="register-section-title">Datos personales</h2>

          <div class="form-group">
            <label for="nombres">Nombres <span class="required">*</span></label>
            <input type="text" id="nombres" class="form-control form-control-lg"
                   autocomplete="off" placeholder="Tus nombres" data-kb="alpha">
          </div>
          <div class="form-group">
            <label for="apellidos">Apellidos <span class="required">*</span></label>
            <input type="text" id="apellidos" class="form-control form-control-lg"
                   autocomplete="off" placeholder="Tus apellidos" data-kb="alpha">
          </div>

          <div class="form-group">
            <label>Fecha de nacimiento <span class="required">*</span></label>
            <div class="dob-row">
              <select id="dob_d" class="form-control dob-select" data-kb="none">
                <option value="">DD</option>
                ${Array.from({length:31},(_,i)=>`<option value="${String(i+1).padStart(2,'0')}">${String(i+1).padStart(2,'0')}</option>`).join('')}
              </select>
              <select id="dob_m" class="form-control dob-select" data-kb="none">
                <option value="">Mes</option>
                ${MONTHS.map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}">${m}</option>`).join('')}
              </select>
              <select id="dob_y" class="form-control dob-select" data-kb="none">
                <option value="">AAAA</option>
                ${(()=>{const cur=new Date().getFullYear(); const arr=[]; for(let y=cur-5;y>=cur-100;y--) arr.push(`<option value="${y}">${y}</option>`); return arr.join('');})()}
              </select>
            </div>
            <div class="field-error" id="dob-err"></div>
          </div>

          <div class="form-group">
            <label>Sexo <span class="required">*</span></label>
            <div class="radio-row">
              <label class="radio-opt" id="radio-m">
                <input type="radio" name="sexo" value="M"> Masculino
              </label>
              <label class="radio-opt" id="radio-f">
                <input type="radio" name="sexo" value="F"> Femenino
              </label>
            </div>
            <div class="field-error" id="sexo-err"></div>
          </div>
        </div>

        <!-- ──────────────── UBICACIÓN ──────────────── -->
        <div class="register-section">
          <h2 class="register-section-title">Ubicación y ocupación</h2>

          <div class="form-group">
            <label for="direccion">Dirección <span class="required">*</span></label>
            <input type="text" id="direccion" class="form-control form-control-lg"
                   autocomplete="off" placeholder="Ej: Calle 10 # 5-20" data-kb="alpha">
          </div>
          <div class="form-group">
            <label for="ciudad">Ciudad <span class="required">*</span></label>
            <input type="text" id="ciudad" class="form-control form-control-lg"
                   autocomplete="off" placeholder="Ej: Popayán" data-kb="alpha">
          </div>
          <div class="form-group">
            <label for="comuna">Comuna <span class="optional">(opcional)</span></label>
            <input type="text" id="comuna" class="form-control form-control-lg"
                   autocomplete="off" placeholder="Ej: Centro" data-kb="alpha">
          </div>
          <div class="form-group">
            <label for="ocupacion">Ocupación <span class="optional">(opcional)</span></label>
            <input type="text" id="ocupacion" class="form-control form-control-lg"
                   autocomplete="off" placeholder="Ej: Docente" data-kb="alpha">
          </div>
        </div>

        <!-- ──────────────── SUBMIT ──────────────── -->
        <div class="register-section register-section--submit">
          <button type="button" class="btn btn-primary btn-lg btn-full" id="submit-btn">
            Registrarme
          </button>
          <p class="register-note">
            Al registrarte, tus datos quedarán guardados en el sistema de la clínica
            para futuras citas y servicios.
          </p>
        </div>

      </div>
    </div>
  `;

  // ── Radio button visual feedback ─────────────────────────────────────────────
  container.querySelectorAll('input[name=sexo]').forEach((radio) => {
    radio.addEventListener('change', () => {
      container.querySelector('#radio-m').classList.toggle('selected', container.querySelector('#radio-m input').checked);
      container.querySelector('#radio-f').classList.toggle('selected', container.querySelector('#radio-f input').checked);
    });
  });

  // ── Confirm field inline validation on blur ──────────────────────────────────
  const setFieldError = (id, msg) => {
    const el = container.querySelector(`#${id}`);
    if (el) {
      el.textContent = msg;
      el.style.display = msg ? 'block' : 'none';
    }
  };

  const markInput = (id, hasError) => {
    const el = container.querySelector(`#${id}`);
    if (el) el.classList.toggle('input-error', hasError);
  };

  const checkConfirm = (id, confirmId, errId, label) => {
    const a = container.querySelector(`#${id}`)?.value?.trim();
    const b = container.querySelector(`#${confirmId}`)?.value?.trim();
    const mismatch = a && b && a.toLowerCase() !== b.toLowerCase();
    setFieldError(errId, mismatch ? `Los ${label} no coinciden.` : '');
    markInput(confirmId, mismatch);
  };

  container.querySelector('#cedula_confirm').addEventListener('blur', () =>
    checkConfirm('cedula', 'cedula_confirm', 'cedula_confirm-err', 'números de cédula'));
  container.querySelector('#celular_confirm').addEventListener('blur', () =>
    checkConfirm('celular', 'celular_confirm', 'celular_confirm-err', 'celulares'));
  container.querySelector('#email_confirm').addEventListener('blur', () =>
    checkConfirm('email', 'email_confirm', 'email_confirm-err', 'correos'));

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const val = (id) => container.querySelector(`#${id}`)?.value?.trim() ?? '';
  const showError = (msg) => {
    const el = container.querySelector('#form-error');
    el.textContent = msg;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const clearError = () => {
    container.querySelector('#form-error').style.display = 'none';
  };

  // ── Validation ───────────────────────────────────────────────────────────────
  function validate() {
    clearError();
    // Clear all field errors
    container.querySelectorAll('.field-error').forEach((e) => { e.textContent=''; e.style.display='none'; });
    container.querySelectorAll('.input-error').forEach((e) => e.classList.remove('input-error'));

    let ok = true;

    const cedula    = val('cedula');
    const ceduConf  = val('cedula_confirm');
    const celular   = val('celular');
    const celConf   = val('celular_confirm');
    const email     = val('email');
    const emailConf = val('email_confirm');
    const nombres   = val('nombres');
    const apellidos = val('apellidos');
    const dobD = val('dob_d');
    const dobM = val('dob_m');
    const dobY = val('dob_y');
    const sexo      = container.querySelector('input[name=sexo]:checked')?.value;
    const direccion = val('direccion');
    const ciudad    = val('ciudad');

    if (!/^\d{6,15}$/.test(cedula)) { showError('Cédula inválida. Solo números, 6 a 15 dígitos.'); markInput('cedula', true); return false; }
    if (cedula !== ceduConf)         { setFieldError('cedula_confirm-err', 'Las cédulas no coinciden.'); markInput('cedula_confirm', true); ok = false; }
    if (!/^3\d{9}$/.test(celular))  { showError('Celular inválido. Debe iniciar en 3 y tener 10 dígitos.'); markInput('celular', true); return false; }
    if (celular !== celConf)         { setFieldError('celular_confirm-err', 'Los celulares no coinciden.'); markInput('celular_confirm', true); ok = false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('Correo electrónico inválido.'); markInput('email', true); return false; }
    if (email.toLowerCase() !== emailConf.toLowerCase()) { setFieldError('email_confirm-err', 'Los correos no coinciden.'); markInput('email_confirm', true); ok = false; }
    if (!ok) { showError('Corrige los campos marcados antes de continuar.'); return false; }

    if (nombres.length < 2)   { showError('Ingresa tus nombres (al menos 2 caracteres).'); markInput('nombres', true); return false; }
    if (apellidos.length < 2) { showError('Ingresa tus apellidos (al menos 2 caracteres).'); markInput('apellidos', true); return false; }

    if (!dobD || !dobM || !dobY) { setFieldError('dob-err', 'Selecciona día, mes y año de nacimiento.'); return false; }
    const dob = new Date(`${dobY}-${dobM}-${dobD}T00:00:00`);
    if (isNaN(dob.getTime())) { setFieldError('dob-err', 'Fecha de nacimiento inválida.'); return false; }
    const now = new Date();
    const minYear = now.getFullYear() - 120;
    const maxYear = now.getFullYear() - 5;
    if (Number(dobY) < minYear || Number(dobY) > maxYear) {
      setFieldError('dob-err', 'Fecha de nacimiento fuera de rango (5 – 120 años).');
      return false;
    }

    if (!sexo) { setFieldError('sexo-err', 'Selecciona tu sexo.'); return false; }
    if (direccion.length < 4) { showError('Ingresa tu dirección (al menos 4 caracteres).'); markInput('direccion', true); return false; }
    if (ciudad.length < 2)    { showError('Ingresa tu ciudad (al menos 2 caracteres).'); markInput('ciudad', true); return false; }

    return true;
  }

  // ── Submit ───────────────────────────────────────────────────────────────────
  let submitting = false;

  container.querySelector('#submit-btn').addEventListener('click', async () => {
    if (submitting) return;
    if (!validate()) return;

    submitting = true;
    const btn = container.querySelector('#submit-btn');
    btn.disabled = true;
    btn.textContent = 'Registrando...';

    const dobD = val('dob_d');
    const dobM = val('dob_m');
    const dobY = val('dob_y');

    try {
      await api.registerPatient({
        cedula:          val('cedula'),
        cedula_confirm:  val('cedula_confirm'),
        celular:         val('celular'),
        celular_confirm: val('celular_confirm'),
        email:           val('email'),
        email_confirm:   val('email_confirm'),
        nombres:         val('nombres'),
        apellidos:       val('apellidos'),
        fecha_nacimiento:`${dobY}-${dobM}-${dobD}`,
        sexo:            container.querySelector('input[name=sexo]:checked')?.value,
        direccion:       val('direccion'),
        ciudad:          val('ciudad'),
        comuna:          val('comuna') || null,
        ocupacion:       val('ocupacion') || null,
      });

      toast('¡Registro exitoso! Ahora puedes iniciar sesión.', 'success');
      navigate('login-cedula', { policyVersion, policyHash });
    } catch (err) {
      submitting = false;
      btn.disabled = false;
      btn.textContent = 'Registrarme';

      if (err instanceof ApiError) {
        if (err.status === 409) {
          showError(
            'Ya existe una cuenta con ese correo o celular. ' +
            '¿Olvidaste que ya eres paciente? Usa la opción de inicio de sesión.'
          );
        } else if (err.status === 400) {
          const fields = err.body?.fields;
          if (fields?.length) {
            showError('Corrige los campos: ' + fields.map((f) => f.message).join('. '));
          } else {
            showError('Datos inválidos. Revisa los campos.');
          }
        } else if (err.status === 422) {
          showError('La clínica no pudo guardar tus datos. Verifica la información o contacta recepción.');
        } else {
          showError('No pudimos completar el registro. Intenta de nuevo.');
        }
      } else {
        toast('Error de conexión. Verifica la red del kiosco.', 'error');
      }
    }
  });

  // ── Back ──────────────────────────────────────────────────────────────────────
  container.querySelector('#back-btn').addEventListener('click', () => {
    navigate('login-cedula', { policyVersion, policyHash });
  });

  return null;
}
