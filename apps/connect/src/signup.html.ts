/**
 * Meta's Embedded Signup, on the relay's own page (spec 2026-10-18 §3.2): the person logs in to Facebook, chooses
 * "connect my existing WhatsApp Business app number" and scans the code with the phone. Meta's popup tells this page
 * the account and number ids; the login callback gives a one-time code. Both go to /wa/done; nothing else leaves.
 */
export function signupPage(o: { appId: string; configId: string; version: string; state: string; back: string | null }) {
  const js = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect WhatsApp · LUME</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#eef0f3;color:#0a0c11}
main{background:#fff;border-radius:16px;padding:28px 32px;box-shadow:0 0 0 .5px rgba(12,18,32,.1),0 18px 50px rgba(12,18,32,.12);max-width:440px;text-align:center}
h1{font-size:18px;margin:0 0 6px}p{color:#5a606d;margin:0 0 18px}
button{font:inherit;font-weight:600;height:44px;padding:0 20px;border:0;border-radius:10px;background:#1877f2;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #2a5bff;outline-offset:2px}a{color:#2a5bff;font-weight:600}
#msg{margin-top:14px;min-height:1.5em}</style></head>
<body><main>
<h1>Connect your WhatsApp number</h1>
<p>Log in to Facebook, choose your WhatsApp Business app number, and scan the code with the phone that runs it.</p>
<button id="go" type="button">Continue with Facebook</button>
<p id="msg" role="status"></p>
${o.back ? `<a href="${o.back.replace(/"/g, "&quot;")}">Back to LUME</a>` : ""}
<form id="f" method="post" action="/wa/done" hidden>
<input type="hidden" name="state" value="${o.state.replace(/"/g, "&quot;")}">
<input type="hidden" name="code"><input type="hidden" name="waba_id"><input type="hidden" name="phone_number_id">
</form>
</main>
<script>
var got = { code: null, waba: null, phone: null };
var f = document.getElementById("f"), msg = document.getElementById("msg");
function finish() {
  if (!got.code || !got.waba || !got.phone) return;
  f.code.value = got.code; f.waba_id.value = got.waba; f.phone_number_id.value = got.phone;
  msg.textContent = "Connecting…"; f.submit();
}
window.addEventListener("message", function (e) {
  if (!/^https:\\/\\/([a-z]+\\.)?facebook\\.com$/.test(e.origin)) return;
  try {
    var d = JSON.parse(e.data);
    if (d.type !== "WA_EMBEDDED_SIGNUP") return;
    if (d.event === "CANCEL") { msg.textContent = "You didn't finish connecting. Choose Continue with Facebook to try again."; return; }
    if (d.data && d.data.waba_id && d.data.phone_number_id) { got.waba = d.data.waba_id; got.phone = d.data.phone_number_id; finish(); }
  } catch (_) {}
});
window.fbAsyncInit = function () {
  FB.init({ appId: ${js(o.appId)}, autoLogAppEvents: true, xfbml: false, version: ${js(o.version)} });
};
document.getElementById("go").addEventListener("click", function () {
  FB.login(function (r) {
    if (r.authResponse && r.authResponse.code) { got.code = r.authResponse.code; finish(); }
    else msg.textContent = "Facebook didn't connect the number. Choose Continue with Facebook to try again.";
  }, {
    config_id: ${js(o.configId)},
    response_type: "code",
    override_default_response_type: true,
    extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }
  });
});
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
</body></html>`;
}
