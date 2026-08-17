
/* Local dev server for the Primary Capital site.
 *
 * Serves the static files AND owns the entire Salesforce login flow behind one
 * API route, POST /api/login. The browser posts { username, password } here and
 * gets back a single-use frontdoor_uri to navigate to — nothing else.
 *
 * Why the whole flow lives server-side rather than in the browser:
 *   - /services/oauth2/singleaccess (the last step) does NOT support CORS at all.
 *     It is not in Salesforce's CORS-enabled OAuth endpoint list, so it can only
 *     ever be called server-to-server. A backend is therefore mandatory anyway.
 *   - Doing the earlier steps here too means we need no CORS allowlist entry and
 *     no "Enable CORS for OAuth endpoints" master switch — the single largest
 *     source of setup failures for this flow.
 *   - The web-scoped access token never reaches the browser.
 *   - The Salesforce host is a server-side constant, so no caller can point this
 *     server at an arbitrary host and have it relay a bearer token there.
 *
 * Flow (see README.md "How login works"):
 *   1. POST /services/oauth2/authorize  — Basic auth = username:password,
 *      Auth-Request-Type: Named-User, response_type=code_credentials, PKCE.
 *      Salesforce validates the credentials and returns { code } via the OAuth
 *      "echo" endpoint rather than a real redirect.
 *   2. POST /services/oauth2/token      — code + PKCE code_verifier -> access_token.
 *   3. GET  /services/oauth2/singleaccess — Single Access UI Bridge API. Exchanges
 *      the access token for a one-time, ~1-minute frontdoor_uri that logs the
 *      browser into the real portal UI. Requires the token to carry the `web`
 *      (or `full`) OAuth scope, and a RELATIVE redirect_uri.
 *
 * No dependencies beyond Node's built-ins (Node 18+, for global fetch).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');

const PORT = process.env.PORT || 5500;
const ROOT = __dirname;

/* ---- Salesforce configuration -------------------------------------------
 * Server-side only. These deliberately do NOT come from the page (an earlier
 * version read them from <meta> tags and accepted the target host in the
 * request body, which let any caller relay an access token anywhere).
 */

// Origin of the Experience Cloud site, no trailing slash, no site path.
const SF_ORIGIN = process.env.SF_ORIGIN
    || 'https://app-computing-6782-dev-ed.scratch.my.site.com';

/* The Experience Cloud site's browsable URL path prefix.
 *
 * CAREFUL: this is NOT the same string as <urlPathPrefix> on the Network
 * metadata. For LWR sites Salesforce stores "<name>vforcesite" there — that
 * belongs to the companion Visualforce-hosting site — while the portal is
 * browsed under the short form. Verified live on this org:
 *   GET /chargeonvforcesite/          -> 301 to /chargeon/
 *   GET /chargeon/my-financial-accounts -> 200  (the real route)
 *   GET /chargeon/login                 -> 200  (the real login page)
 * So LWR routes, and therefore the UI bridge's redirect_uri, use "chargeon".
 * The OAuth endpoints answer under either prefix.
 */
const SF_SITE_PATH = process.env.SF_SITE_PATH || 'chargeon';

// Consumer Key of the Connected App / External Client App.
const SF_CLIENT_ID = process.env.SF_CLIENT_ID
    || '3MVG9_IS_Cbuy2eZFIcWoIPy2w0C5cbJocTLs459m9l2U0RJEBzBXIK5buxJT3VQFo7B2y332YFC2dbytw0qJ';

// Space-separated, per the OAuth spec and Salesforce's own docs. Commas do not
// work. `web` is what /singleaccess checks for; without it that call fails with
// Invalid_Scope. Every scope listed here MUST also be selected on the app itself
// — requesting a scope the app doesn't have makes Salesforce stop treating the
// request as headless and 302 to the interactive login page instead.
const SF_SCOPES = process.env.SF_SCOPES || 'openid api web';

/* The route the user lands on. The full redirect_uri sent to singleaccess is
 * "<site path prefix>/<this>" — see buildLandingPath().
 *
 * NOTE: no "/s/" segment. Many Experience Builder sites serve routes under /s/,
 * but this one does not — verified live: /chargeon/my-financial-accounts returns
 * 200 while /chargeon/s/my-financial-accounts returns 404 to a logged-in user.
 * The value matches "urlName" in the route's content.json under
 * digitalExperiences/site/ChargeOn_Payment_Portal1/sfdc_cms__route/.
 * If a site ever does need /s/, set SF_LANDING_PATH explicitly.
 */
const SF_LANDING_ROUTE = process.env.SF_LANDING_ROUTE || 'my-financial-accounts';

// Escape hatch: set this to send an exact relative path and skip all derivation.
const SF_LANDING_PATH = process.env.SF_LANDING_PATH || null;

const SF_SITE_URL = `${SF_ORIGIN}/${SF_SITE_PATH}`;

/* Must match the Callback URL registered on the Connected App byte for byte, or
 * Salesforce answers redirect_uri_mismatch. It is registered under the
 * "vforcesite" prefix on this org, which is why it is configured separately from
 * SF_SITE_PATH rather than derived from it. (Re-registering the callback as
 * .../chargeon/services/oauth2/echo and pointing this at SF_SITE_URL would also
 * work — both prefixes serve the OAuth endpoints.)
 */
const SF_CALLBACK_URL = process.env.SF_CALLBACK_URL
    || `${SF_ORIGIN}/chargeonvforcesite/services/oauth2/echo`;

/* The token response carries `sfdc_community_url` — Salesforce's own answer for
   where this user's Experience Cloud site lives. Trust it over our configured
   guess for the UI bridge call, so a mismatched site path prefix can't produce a
   Wrong_Org / No_Access failure or a startURL pointing at a route that doesn't
   exist. Falls back to the configured URL if the field is absent. */
function resolveSiteUrl(tokenResult) {
    const fromToken = tokenResult && tokenResult.sfdc_community_url;
    if (!fromToken) {
        return SF_SITE_URL;
    }
    return fromToken.replace(/\/+$/, '');
}

/* singleaccess requires a RELATIVE path (an absolute URL returns Invalid_Param),
   resolved from the domain root — so it has to include the site's path prefix. */
function buildLandingPath(siteUrl) {
    if (SF_LANDING_PATH) {
        return SF_LANDING_PATH;
    }
    let prefix = new URL(siteUrl).pathname.replace(/^\/+|\/+$/g, '');
    // If Salesforce hands back the Visualforce-companion prefix, fold it to the
    // browsable one — LWR routes only exist under the short form (see SF_SITE_PATH).
    prefix = prefix.replace(/vforcesite$/, '');
    return prefix ? `${prefix}/${SF_LANDING_ROUTE}` : SF_LANDING_ROUTE;
}

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
};

function serveStatic(req, res) {
    let requestPath = decodeURIComponent(req.url.split('?')[0]);
    if (requestPath === '/') {
        requestPath = '/index.html';
    }
    const filePath = path.join(ROOT, requestPath);

    // Prevent path traversal outside the site root.
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            // Bodies are either { username, password } or a counselling enquiry, whose
            // message field alone can be 32 KB — hence the headroom. Apex truncates
            // the message rather than rejecting it, so this cap only stops abuse.
            if (raw.length > 65536) {
                reject(new Error('body_too_large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function base64Url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair() {
    const codeVerifier = base64Url(crypto.randomBytes(64));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    return { codeVerifier, codeChallenge };
}

/* ---- Outbound calls to Salesforce ---------------------------------------
 *
 * WHY THIS EXISTS. Node's fetch throws a bare `TypeError: fetch failed` when the
 * connection never gets made — DNS, TLS, connect refused, all of it — with the
 * real reason hidden on `err.cause`. Two things went wrong because of that:
 *
 *   1. The first login attempt after the machine's DNS cache went cold failed
 *      with EAI_AGAIN, and a retry half a minute later succeeded. This host is a
 *      four-hop CNAME chain (…scratch.my.site.com -> h.edge2.salesforce.com ->
 *      st.edge.india.edge2.salesforce.com -> st1.edge.sfdc-*), so a cold lookup
 *      is slow enough for getaddrinfo to give up. Retrying is what turns "the
 *      first click never works" into "the first click takes a moment longer".
 *
 *   2. The literal string "fetch failed" was shown to the person logging in, on
 *      a 401, which told them their password was wrong when the network was at
 *      fault. Network problems are now tagged, logged with their real cause, and
 *      answered with 503 and a sentence a human can act on.
 */
/* THE ROOT CAUSE, measured rather than guessed.
 *
 * On this machine, resolving the org host intermittently failed like this:
 *
 *   dns.lookup(host)              -> FAIL EAI_AGAIN     <- what fetch() uses
 *   dns.lookup(host, {family:4})  -> OK 141.163.216.225
 *
 * The host publishes no AAAA record. The default lookup asks for A *and* AAAA,
 * the AAAA query stalls, and the whole lookup fails — so fetch() throws its
 * useless "fetch failed". An IPv4-only lookup answers immediately, and once it
 * has, the OS cache is warm and everything works again... until the cache
 * expires and the next click pays for it. That is precisely the reported
 * symptom: fails now, works if you try again half a minute later.
 *
 * So: prefer IPv4, keep the entry warm in the background, and re-prime it with
 * an IPv4-only lookup before retrying a DNS failure.
 */
dns.setDefaultResultOrder('ipv4first');

const SF_HOST = new URL(SF_ORIGIN).hostname;

/* An IPv4-only lookup. This is the one that works when the default does not, so
   it is what we use to put a good answer in the resolver cache. */
function primeDns(reason) {
    return new Promise((resolve) => {
        dns.lookup(SF_HOST, { family: 4 }, (err, address) => {
            if (err) {
                console.error(`[dns] prime (${reason}) failed: ${err.code}`);
            } else if (reason !== 'keepalive') {
                console.log(`[dns] prime (${reason}) -> ${address}`);
            }
            resolve(!err);
        });
    });
}

/* Windows caches negative DNS answers too, so leaving this to chance means the
   first visitor after a quiet spell is the one who sees the failure. Re-priming
   well inside the usual TTL keeps that from ever being their problem. */
const DNS_KEEPALIVE_MS = 20_000;
primeDns('startup');
setInterval(() => primeDns('keepalive'), DNS_KEEPALIVE_MS).unref();

class UpstreamUnavailableError extends Error {
    constructor(cause) {
        super('Could not reach the login service. Please try again in a moment.');
        this.name = 'UpstreamUnavailableError';
        this.isNetwork = true;
        this.cause = cause;
    }
}

const RETRYABLE = new Set([
    'EAI_AGAIN',      // DNS lookup timed out — the cold-cache case above
    'ENOTFOUND',      // DNS returned nothing, sometimes transient on this chain
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT'
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One transport-level retry policy for every Salesforce call. HTTP errors are
   NOT retried — a 400 from Salesforce is an answer, not a failure to ask. */
async function sfFetch(url, options, label) {
    const attempts = 3;
    let lastCause = null;

    for (let i = 1; i <= attempts; i++) {
        try {
            return await fetch(url, options);
        } catch (err) {
            const code = (err.cause && err.cause.code) || err.code;
            lastCause = err.cause || err;
            const retryable = code ? RETRYABLE.has(code) : true;
            console.error(
                `[${label}] transport error on attempt ${i}/${attempts}: ${code || err.message}`
            );
            if (!retryable || i === attempts) {
                break;
            }
            // A DNS failure is not something to simply wait out: re-prime with
            // the IPv4-only lookup that works, then retry. Without this the
            // retries just repeat the same failing AAAA query.
            if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
                await primeDns('retry');
            }
            // 300ms, then 900ms. Long enough for a DNS retry to land, short
            // enough that a person waiting on a login modal does not give up.
            await sleep(i * 300 * (i === 1 ? 1 : 2));
        }
    }
    throw new UpstreamUnavailableError(lastCause);
}

async function readResponse(resp) {
    const raw = await resp.text();
    let data = null;
    try {
        data = JSON.parse(raw);
    } catch {
        /* Salesforce returns an HTML login page when it stops treating a request
           as headless — keep the raw text so that shows up in the logs. */
    }
    return { data, raw };
}

/* Salesforce reports failures in several shapes: OAuth's {error, error_description},
   the UI Bridge API's {error} codes (Invalid_Scope, Invalid_Param, Bad_OAuth_Token,
   Missing_OAuth_Token, No_Access, Wrong_Org), or a bare HTML login page. Surface
   whichever we got rather than flattening everything to a generic message. */
function describeFailure(step, resp, data, raw) {
    if (data && (data.error_description || data.error)) {
        const code = data.error && data.error_description ? ` [${data.error}]` : '';
        return `${step}: ${data.error_description || data.error}${code}`;
    }
    if (/<html/i.test(raw || '')) {
        return `${step}: Salesforce returned an HTML login page (HTTP ${resp.status}) instead of a headless `
            + 'response — the request was not accepted as a headless request. Check that every scope in '
            + 'SF_SCOPES is selected on the Connected App, that "Require user credentials in the POST body" '
            + 'is unchecked, and that "Allow Authorization Code and Credentials Flows" is on.';
    }
    return `${step}: HTTP ${resp.status} ${(raw || '').trim().slice(0, 300)}`;
}

// Step 1 — exchange the user's credentials for an authorization code.
async function requestAuthorizationCode(username, password, codeChallenge) {
    const body = new URLSearchParams({
        response_type: 'code_credentials',
        client_id: SF_CLIENT_ID,
        redirect_uri: SF_CALLBACK_URL,
        code_challenge: codeChallenge,
        scope: SF_SCOPES
    });

    const resp = await sfFetch(`${SF_SITE_URL}/services/oauth2/authorize`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Auth-Request-Type': 'Named-User',
            'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
        },
        body: body.toString()
    }, 'login/authorize');

    const { data, raw } = await readResponse(resp);
    console.log(`[login] authorize -> ${resp.status}`, data ? Object.keys(data).join(',') : raw.slice(0, 500));
    if (!resp.ok || !data || !data.code) {
        // A clean 400 with an OAuth error here is almost always a bad password.
        if (resp.status === 400 && data && data.error) {
            throw new Error('Invalid username or password.');
        }
        throw new Error(describeFailure('Authorization request failed', resp, data, raw));
    }
    return data;
}

// Step 2 — exchange the authorization code for an access token.
async function requestAccessToken(code, codeVerifier) {
    const body = new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: SF_CLIENT_ID,
        redirect_uri: SF_CALLBACK_URL,
        code_verifier: codeVerifier
    });

    const resp = await sfFetch(`${SF_SITE_URL}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    }, 'login/token');

    const { data, raw } = await readResponse(resp);
    console.log(`[login] token -> ${resp.status} scope="${(data && data.scope) || ''}"`
        + ` sfdc_community_url="${(data && data.sfdc_community_url) || ''}"`);
    if (!resp.ok || !data || !data.access_token) {
        throw new Error(describeFailure('Token request failed', resp, data, raw));
    }
    // Fail loudly here rather than letting singleaccess return a cryptic
    // Invalid_Scope — this is the single most common misconfiguration.
    const granted = (data.scope || '').split(/\s+/);
    if (!granted.includes('web') && !granted.includes('full')) {
        throw new Error(
            `The access token was issued with scope "${data.scope || '(none)'}", which includes neither `
            + '"web" nor "full". The Single Access UI Bridge API requires one of them. Add the Web scope '
            + 'to the Connected App, then wait ~10 minutes for the change to propagate before retesting.'
        );
    }
    return data;
}

// Step 3 — bridge the access token into a real logged-in browser session.
async function requestFrontdoorUri(accessToken, siteUrl, landingPath) {
    const url = `${siteUrl}/services/oauth2/singleaccess`
        + `?redirect_uri=${encodeURIComponent(landingPath)}`;

    const resp = await sfFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
    }, 'login/singleaccess');

    const { data, raw } = await readResponse(resp);
    console.log(`[login] singleaccess -> ${resp.status}`, raw.slice(0, 500));
    if (!resp.ok || !data || !data.frontdoor_uri) {
        throw new Error(describeFailure('UI bridge failed', resp, data, raw));
    }
    return data.frontdoor_uri;
}

async function handleLogin(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch {
        sendJson(res, 400, { error: 'Malformed request.' });
        return;
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
        sendJson(res, 400, { error: 'Enter both a username and a password.' });
        return;
    }

    try {
        const { codeVerifier, codeChallenge } = generatePkcePair();
        const authResult = await requestAuthorizationCode(username, password, codeChallenge);
        const tokenResult = await requestAccessToken(authResult.code, codeVerifier);
        const siteUrl = resolveSiteUrl(tokenResult);
        const landingPath = buildLandingPath(siteUrl);
        const frontdoorUri = await requestFrontdoorUri(tokenResult.access_token, siteUrl, landingPath);
        // Single-use, valid for about a minute — the browser must navigate now.
        sendJson(res, 200, { frontdoor_uri: frontdoorUri });
    } catch (err) {
        // A network failure is not a bad password, and must not be reported as
        // one. Answering 401 with Node's raw "fetch failed" told people their
        // credentials were wrong when the real problem was DNS.
        if (err.isNetwork) {
            const cause = err.cause || {};
            console.error(`[login] upstream unreachable: ${cause.code || cause.message || 'unknown'}`);
            sendJson(res, 503, { error: err.message });
            return;
        }
        console.error('[login] failed:', err.message);
        sendJson(res, 401, { error: err.message });
    }
}

/* ─── Counselling enquiry intake ──────────────────────────────────────────────

   The visitor's counselling form posts here, and this relays it to the org's
   /services/apexrest/fsc/v1/enquiry.

   A SEPARATE OAuth client from the login flow above, deliberately. That one is a
   named-user public client that mints portal sessions; this one is a
   client-credentials app running as an integration user whose permission set can
   do exactly one thing — create a Counselling_Request__c. Sharing a client
   between a marketing form and a session-minting flow would hand the form far
   more reach than it needs.

   The filtering here (honeypot, reCAPTCHA, rate limit) is a filter, not a
   guarantee: Apex re-validates everything, because anything reachable over HTTP
   is eventually called directly. */

const SF_INTAKE_CLIENT_ID = process.env.SF_INTAKE_CLIENT_ID || '';
const SF_INTAKE_CLIENT_SECRET = process.env.SF_INTAKE_CLIENT_SECRET || '';
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || '';
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || '0.5');

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitBuckets = new Map();

/* Cached in module scope and reused until it expires. Minting a token per
   submission would triple the latency of every enquiry and burn API calls for
   nothing. `inFlight` collapses concurrent refreshes into one request. */
let intakeToken = { value: null, expiresAt: 0, inFlight: null };

async function getIntakeToken(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && intakeToken.value && now < intakeToken.expiresAt) {
        return intakeToken.value;
    }
    if (intakeToken.inFlight) {
        return intakeToken.inFlight;
    }
    if (!SF_INTAKE_CLIENT_ID || !SF_INTAKE_CLIENT_SECRET) {
        throw new Error('intake_not_configured');
    }

    intakeToken.inFlight = (async () => {
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: SF_INTAKE_CLIENT_ID,
            client_secret: SF_INTAKE_CLIENT_SECRET
        });
        const resp = await sfFetch(`${SF_ORIGIN}/services/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        }, 'enquiry/token');
        const { data } = await readResponse(resp);
        if (!resp.ok || !data || !data.access_token) {
            throw new Error('intake_auth_failed');
        }
        // No expires_in on this grant; 20 minutes is comfortably inside the org's
        // session timeout and a 401 refresh path covers being wrong.
        intakeToken.value = data.access_token;
        intakeToken.expiresAt = Date.now() + 20 * 60 * 1000;
        intakeToken.inFlight = null;
        return intakeToken.value;
    })().catch((err) => {
        intakeToken.inFlight = null;
        throw err;
    });

    return intakeToken.inFlight;
}

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function rateLimited(ip) {
    const now = Date.now();
    const hits = (rateLimitBuckets.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_MAX) {
        rateLimitBuckets.set(ip, hits);
        return true;
    }
    hits.push(now);
    rateLimitBuckets.set(ip, hits);
    // Cheap eviction so a long-running dev server does not grow a bucket per IP forever.
    if (rateLimitBuckets.size > 5000) {
        rateLimitBuckets.clear();
    }
    return false;
}

async function recaptchaPasses(token, ip) {
    // Not configured means not enforced — the dev server has to stay usable
    // without a Google key. Configure it before this is reachable from the
    // internet.
    if (!RECAPTCHA_SECRET) {
        return true;
    }
    if (!token) {
        return false;
    }
    try {
        const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token, remoteip: ip })
        });
        const { data } = await readResponse(resp);
        return Boolean(data && data.success && (data.score === undefined || data.score >= RECAPTCHA_MIN_SCORE));
    } catch {
        return false;
    }
}

async function postEnquiryToSalesforce(payload) {
    const send = async (token) =>
        fetch(`${SF_ORIGIN}/services/apexrest/fsc/v1/enquiry`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

    let resp = await send(await getIntakeToken(false));
    if (resp.status === 401) {
        // The cached token outlived its real session. One retry with a fresh one.
        resp = await send(await getIntakeToken(true));
    }
    return readResponse(resp).then(({ data }) => ({ status: resp.status, data }));
}

async function handleEnquiry(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch {
        sendJson(res, 400, { success: false, errorMessage: 'Malformed request.' });
        return;
    }

    // Honeypot: a field no human can see and no human fills in. Answer 200 as if
    // it worked — telling a bot it was detected only teaches it what to avoid.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
        console.log('[enquiry] honeypot triggered, dropped');
        sendJson(res, 200, { success: true, reference: null });
        return;
    }

    const ip = clientIp(req);
    if (rateLimited(ip)) {
        sendJson(res, 429, { success: false, errorMessage: 'Too many submissions. Please try again shortly.' });
        return;
    }
    if (!(await recaptchaPasses(body.recaptchaToken, ip))) {
        sendJson(res, 400, { success: false, errorMessage: 'We could not verify that you are human. Please try again.' });
        return;
    }
    if (!body.requestId) {
        sendJson(res, 400, { success: false, errorMessage: 'Malformed request.' });
        return;
    }

    const payload = {
        requestId: body.requestId,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        company: body.company,
        street: body.street,
        city: body.city,
        stateCode: body.stateCode,
        postalCode: body.postalCode,
        country: body.country,
        requestType: body.requestType,
        loanType: body.loanType,
        insuranceType: body.insuranceType,
        requestedAmount: body.requestedAmount === '' || body.requestedAmount === undefined
            ? null
            : Number(body.requestedAmount),
        tenureMonths: body.tenureMonths === '' || body.tenureMonths === undefined
            ? null
            : Number(body.tenureMonths),
        topic: body.topic,
        message: body.message,
        consentToContact: body.consentToContact === true,
        sourceForm: 'primary-capital-website/contact',
        submittedFromIp: ip
    };

    try {
        const { status, data } = await postEnquiryToSalesforce(payload);
        // Never relay a Salesforce id, host or raw error to the browser — only
        // the reference the visitor can quote back to us, and a message they can
        // act on.
        if (data && data.success) {
            console.log(`[enquiry] created ${data.reference}`);
            sendJson(res, 200, { success: true, reference: data.reference });
            return;
        }
        console.log(`[enquiry] rejected (${status}): ${data && data.errorCode}`);
        sendJson(res, 200, {
            success: false,
            errorField: data && data.errorField,
            errorMessage: (data && data.errorMessage) || 'We could not record your enquiry.'
        });
    } catch (err) {
        console.error('[enquiry] failed:', err.message);
        sendJson(res, 502, {
            success: false,
            errorMessage: 'We could not record your enquiry right now. Please try again shortly.'
        });
    }
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/login') {
        handleLogin(req, res);
        return;
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/enquiry') {
        handleEnquiry(req, res);
        return;
    }
    if (req.method === 'GET') {
        serveStatic(req, res);
        return;
    }
    res.writeHead(405);
    res.end('Method not allowed');
});

server.listen(PORT, () => {
    console.log(`Primary Capital dev server running at http://localhost:${PORT}`);
    console.log(`Salesforce auth site: ${SF_SITE_URL}`);
    console.log(`Requested scopes:     ${SF_SCOPES}`);
    console.log(`Landing route:        ${SF_LANDING_PATH || `<site prefix>/${SF_LANDING_ROUTE}`}`);
});
