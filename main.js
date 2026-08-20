/* ===== PRIMARY CAPITAL — main.js ===== */

// ── Navbar scroll effect ──────────────────────────────────────────
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

// ── Hamburger / mobile nav ────────────────────────────────────────
const hamburger = document.getElementById('hamburger');
const navLinks  = document.getElementById('navLinks');

// Inject a mobile login button once
const mobileLoginEl = document.createElement('button');
mobileLoginEl.type = 'button';
mobileLoginEl.className = 'mobile-login-btn';
mobileLoginEl.innerHTML = 'Client Login <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
mobileLoginEl.addEventListener('click', () => {
  navLinks.classList.remove('mobile-open');
  hamburger.classList.remove('open');
  document.body.style.overflow = '';
  openLoginModal();
});
navLinks.appendChild(mobileLoginEl);

hamburger.addEventListener('click', () => {
  const open = !navLinks.classList.contains('mobile-open');
  navLinks.classList.toggle('mobile-open', open);
  hamburger.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
});

// Close menu on link click
navLinks.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => {
    navLinks.classList.remove('mobile-open');
    hamburger.classList.remove('open');
    document.body.style.overflow = '';
  });
});

// Close on outside click
document.addEventListener('click', (e) => {
  if (!navbar.contains(e.target) && navLinks.classList.contains('mobile-open')) {
    navLinks.classList.remove('mobile-open');
    hamburger.classList.remove('open');
    document.body.style.overflow = '';
  }
});

// ── Login modal (Client Login / Secure Client Login) ─────────────
// Opening the modal lazily initializes Salesforce Embedded Login (see
// embedded-login.js) so the cross-origin iframe only loads when a visitor
// actually wants to log in, not on every page view.
const loginModal         = document.getElementById('loginModal');
const loginModalBackdrop = document.getElementById('loginModalBackdrop');
const loginModalClose    = document.getElementById('loginModalClose');
const navLoginBtn        = document.getElementById('navLoginBtn');
const heroLoginBtn       = document.getElementById('heroLoginBtn');

function openLoginModal() {
  loginModal.classList.add('open');
  loginModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const usernameField = document.getElementById('hlUsername');
  usernameField && usernameField.focus();
}

function closeLoginModal() {
  loginModal.classList.remove('open');
  loginModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

navLoginBtn && navLoginBtn.addEventListener('click', openLoginModal);
heroLoginBtn && heroLoginBtn.addEventListener('click', openLoginModal);
loginModalBackdrop && loginModalBackdrop.addEventListener('click', closeLoginModal);
loginModalClose && loginModalClose.addEventListener('click', closeLoginModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && loginModal.classList.contains('open')) {
    closeLoginModal();
  }
});

// ── Intersection Observer — reveal animations ─────────────────────
const revealEls = document.querySelectorAll(
  '.fade-up, .fade-in-right, .slide-up, .reveal'
);

const io = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      io.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

revealEls.forEach(el => io.observe(el));

// ── Counselling enquiry form ──────────────────────────────────────
//
// This form is the front of the lending funnel, not a "contact us" box. When the
// visitor chooses to apply, they fill in the application itself — product, state,
// amount, term — and those values travel all the way to the Financial Account a
// sales rep creates after counselling. The rep never re-types them.
//
// The validation below deliberately MIRRORS the Apex rules in
// FscEnquiryIntakeRest. Being looser here is a bug in this file, not in the API:
// a visitor who submits a 1-month term and gets back a rejection they could not
// have predicted was failed by this form.

// #requestType is a hidden input, set per page: "General Enquiry" on index.html,
// "Loan Application" on loans.html, "Insurance Application" on insurance.html.
// The visitor never picks it — they picked it by choosing which page to be on,
// which is why each product page's form can be about one product and say so.
const sendBtn     = document.getElementById('sendBtn');
const formSuccess = document.getElementById('formSuccess');
const formError   = document.getElementById('formError');
const requestType = document.getElementById('requestType');
const stateSelect = document.getElementById('stateCode');
const formInputs  = document.querySelectorAll(
  '.contact-form-wrap input, .contact-form-wrap select, .contact-form-wrap textarea'
);

const MIN_TENURE_MONTHS = 2;

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
];

if (stateSelect) {
  US_STATES.forEach(code => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code;
    stateSelect.appendChild(opt);
  });
}

// How long the reference stays on screen after an application is accepted, before
// the page reloads.
const SUCCESS_REFRESH_MS = 3000;

// How long the confirmation stays up on the general enquiry form, which does not
// reload and so has to hand the button back itself.
const SUCCESS_MESSAGE_MS = 8000;

// Held for a whole submission, not regenerated per click. That is what makes a
// double-click or a retry harmless: the server upserts on it and returns the same
// reference instead of creating a second enquiry.
//
// The flip side is that it must NOT survive a completed submission — a second
// enquiry sent under the same id would upsert onto the first record rather than
// create a new one. A page reload takes care of that on the application pages;
// the general enquiry form rotates it by hand (see below).
const newRequestId = () => ((window.crypto && window.crypto.randomUUID)
  ? window.crypto.randomUUID()
  : `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`);

let requestId = newRequestId();

const val = (id) => (document.getElementById(id)?.value || '').trim();

function isInsuranceSelected() {
  return requestType && requestType.value === 'Insurance Application';
}

function isApplication() {
  return requestType && requestType.value !== 'General Enquiry';
}

function showError(message, fieldId) {
  if (formError) {
    formError.textContent = message;
    formError.hidden = false;
  }
  const field = fieldId && document.getElementById(fieldId);
  if (field) {
    field.style.borderColor = '#e05555';
    field.focus();
    setTimeout(() => { field.style.borderColor = ''; }, 4000);
  }
}

function clearError() {
  if (formError) {
    formError.textContent = '';
    formError.hidden = true;
  }
}

function splitName(fullName) {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { firstName: '', lastName: fullName };
  }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** Returns an error {message, fieldId} or null. Mirrors FscEnquiryIntakeRest.validate. */
function validateForm() {
  if (!val('fullname')) return { message: 'Please tell us your name.', fieldId: 'fullname' };
  const email = val('email');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    return { message: 'Please enter a valid email address.', fieldId: 'email' };
  }
  if (!document.getElementById('consent')?.checked) {
    return { message: 'Please confirm we may contact you about this enquiry.', fieldId: 'consent' };
  }

  if (!isApplication()) return null;

  if (isInsuranceSelected()) {
    if (!val('insuranceType')) {
      return { message: 'Please choose the kind of cover you want.', fieldId: 'insuranceType' };
    }
  } else if (!val('loanType')) {
    return { message: 'Please choose the kind of loan you want.', fieldId: 'loanType' };
  }

  if (!val('stateCode')) {
    return { message: 'Please choose the state you live in.', fieldId: 'stateCode' };
  }
  const amount = Number(val('requestedAmount'));
  if (!amount || amount <= 0) {
    return { message: 'Please enter an amount greater than zero.', fieldId: 'requestedAmount' };
  }

  const tenureRaw = val('tenureMonths');
  if (!isInsuranceSelected() && !tenureRaw) {
    return { message: 'Please tell us over how many months you want to repay.', fieldId: 'tenureMonths' };
  }
  if (tenureRaw && Number(tenureRaw) < MIN_TENURE_MONTHS) {
    return { message: `The term must be at least ${MIN_TENURE_MONTHS} months.`, fieldId: 'tenureMonths' };
  }
  return null;
}

function resetFormAfterSuccess(reference) {
  sendBtn.style.display = 'none';
  if (formSuccess) {
    // textContent, not innerHTML: `reference` comes back from the server and is
    // never markup.
    formSuccess.textContent = reference
      ? `✓ Thank you — your reference is ${reference}. We'll be in touch within one business day.`
      : "✓ Message sent! We'll be in touch within one business day.";
    formSuccess.classList.add('show');
  }
  formInputs.forEach(inp => {
    // Never clear the hidden request type — it identifies the page, not the input.
    if (inp === requestType) return;
    if (inp.type === 'checkbox') { inp.checked = false; } else { inp.value = ''; }
  });
}

sendBtn && sendBtn.addEventListener('click', async () => {
  clearError();

  const problem = validateForm();
  if (problem) {
    showError(problem.message, problem.fieldId);
    return;
  }

  const { firstName, lastName } = splitName(val('fullname'));
  const applying = isApplication();
  const tenureRaw = val('tenureMonths');
  const successLabel = applying ? 'Submit application →' : 'Send Message →';

  const payload = {
    requestId,
    firstName,
    lastName,
    email: val('email'),
    phone: val('phone'),
    requestType: requestType ? requestType.value : 'General Enquiry',
    loanType: applying && !isInsuranceSelected() ? val('loanType') : null,
    insuranceType: applying && isInsuranceSelected() ? val('insuranceType') : null,
    stateCode: applying ? val('stateCode') : null,
    requestedAmount: applying ? Number(val('requestedAmount')) : null,
    tenureMonths: tenureRaw ? Number(tenureRaw) : null,
    topic: applying ? null : val('topic'),
    message: val('message'),
    consentToContact: Boolean(document.getElementById('consent')?.checked),
    website: val('website')
  };

  sendBtn.textContent = 'Sending…';
  sendBtn.disabled = true;

  try {
    const resp = await fetch('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));

    if (data && data.success) {
      resetFormAfterSuccess(data.reference);

      // A submitted loan or insurance application ends the visitor's task, so the
      // page goes back to how it was found rather than being patched back into
      // shape field by field. The reload also gives the next application a fresh
      // requestId, which is what keeps it a new record instead of an upsert onto
      // the one just created.
      if (applying) {
        setTimeout(() => window.location.reload(), SUCCESS_REFRESH_MS);
        return;
      }

      // The general enquiry form stays where it is, so rotate the id by hand and
      // hand the button back.
      requestId = newRequestId();
      setTimeout(() => {
        formSuccess && formSuccess.classList.remove('show');
        sendBtn.style.display = '';
        sendBtn.textContent = successLabel;
        sendBtn.disabled = false;
      }, SUCCESS_MESSAGE_MS);
      return;
    }

    // Re-enable rather than hiding the button — the visitor has something to fix.
    showError(data.errorMessage || 'We could not send that. Please try again.', data.errorField);
  } catch {
    showError('We could not reach us just now. Please try again shortly.');
  }

  sendBtn.textContent = successLabel;
  sendBtn.disabled = false;
});

// ── Smooth scroll for anchor links ───────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const id = link.getAttribute('href').slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    const offset = target.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: offset, behavior: 'smooth' });
  });
});

// ── Stat counter animation ────────────────────────────────────────
function animateCount(el, end, suffix = '') {
  let start = 0;
  const dur  = 1800;
  const step = 16;
  const inc  = end / (dur / step);
  const timer = setInterval(() => {
    start = Math.min(start + inc, end);
    el.textContent = (Number.isInteger(end) ? Math.floor(start) : start.toFixed(1)) + suffix;
    if (start >= end) clearInterval(timer);
  }, step);
}

const statsSection = document.querySelector('.stats-bar');
let statsDone = false;

const statsObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !statsDone) {
    statsDone = true;
    const statStrongs = document.querySelectorAll('.stat-item strong');
    if (statStrongs[0]) animateCount(statStrongs[0], 50, 'K+');
    if (statStrongs[2]) animateCount(statStrongs[2], 99.9, '%');
    if (statStrongs[3]) statStrongs[3].textContent = '24/7'; // stays as-is
  }
}, { threshold: 0.3 });

statsSection && statsObserver.observe(statsSection);

// ── Subtle parallax on hero illustration ─────────────────────────
const buildingSvg = document.querySelector('.building-svg');
if (buildingSvg && window.matchMedia('(min-width: 769px)').matches) {
  window.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth  - 0.5) * 10;
    const y = (e.clientY / window.innerHeight - 0.5) * 6;
    buildingSvg.style.transform = `translate(${x}px, ${y}px)`;
  }, { passive: true });
}
