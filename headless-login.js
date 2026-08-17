/* ===== PRIMARY CAPITAL — headless-login.js =====
 *
 * Thin client for the login modal. The whole Salesforce login flow lives in
 * server.js: this posts the credentials to our own POST /api/login and navigates
 * to the single-use frontdoor URI it returns, which drops the visitor straight
 * into the ChargeOn Payment Portal dashboard, already logged in.
 *
 * Nothing Salesforce-specific belongs here. Earlier versions called
 * /services/oauth2/authorize and /services/oauth2/token directly from the page,
 * which needed a CORS allowlist entry plus the separate "Enable CORS for OAuth
 * endpoints" master switch, exposed a web-scoped access token to page JS, and
 * still needed a backend anyway because the last step (/services/oauth2/singleaccess)
 * doesn't support CORS at all. See README.md "How login works".
 */
(function () {
    async function login(username, password) {
        const resp = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        let data = null;
        try {
            data = await resp.json();
        } catch {
            /* fall through to the generic message below */
        }

        if (!resp.ok || !data || !data.frontdoor_uri) {
            throw new Error((data && data.error) || 'Could not complete login. Please try again.');
        }
        return data.frontdoor_uri;
    }

    function initForm() {
        const form = document.getElementById('headlessLoginForm');
        if (!form) {
            return;
        }
        const errorEl = document.getElementById('loginModalError');
        const submitBtn = document.getElementById('loginModalSubmit');

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            errorEl.hidden = true;

            const username = document.getElementById('hlUsername').value.trim();
            const password = document.getElementById('hlPassword').value;
            if (!username || !password) {
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Logging in…';
            try {
                const frontdoorUri = await login(username, password);
                // Single-use and valid for only about a minute — navigate immediately.
                window.location.href = frontdoorUri;
            } catch (err) {
                errorEl.textContent = err.message;
                errorEl.hidden = false;
                submitBtn.disabled = false;
                submitBtn.textContent = 'Log In';
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initForm);
    } else {
        initForm();
    }
})();
