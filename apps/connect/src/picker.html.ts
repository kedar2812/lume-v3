const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function pickerPage(o: {
  accessToken: string;
  pickerKey: string;
  appId: string;
  state: string;
  codeToken: string;
  /** LUME's integrations page for this instance: the way back. */
  back: string | null;
}): string {
  const back = o.back ? o.back.replace(/&/g, "&amp;").replace(/"/g, "&quot;") : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pick a sheet · LUME</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#eef0f3;color:#0a0c11}
main{background:#fff;border-radius:16px;padding:28px 32px;box-shadow:0 0 0 .5px rgba(12,18,32,.1),0 18px 50px rgba(12,18,32,.12);max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 6px}p{color:#5a606d;margin:0}
.again{margin-top:16px;display:flex;gap:16px;justify-content:center;align-items:center}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:8px 14px;background:#2a5bff;color:#fff;cursor:pointer}
a{color:#2a5bff;font-weight:600}</style></head>
<body><main><h1>Pick the sheet LUME should read</h1><p id="msg">Google's picker is opening…</p>
<form id="f" method="post" action="/done" hidden>
<input type="hidden" name="state" value="${o.state.replace(/"/g, "&quot;")}">
<input type="hidden" name="code_token" value="${o.codeToken}">
<input type="hidden" name="file_id"><input type="hidden" name="file_name"></form>
<div class="again" id="again" hidden><button type="button" id="pick">Pick again</button>${back ? `<a href="${back}">Back to LUME</a>` : ""}</div></main>
<script>
const cfg = { token: ${js(o.accessToken)}, key: ${js(o.pickerKey)}, app: ${js(o.appId)} };
function done(data) {
  if (data.action === google.picker.Action.PICKED) {
    const d = data.docs[0];
    const f = document.getElementById("f");
    f.file_id.value = d.id; f.file_name.value = d.name;
    document.getElementById("msg").textContent = "Connecting…";
    f.submit();
  } else if (data.action === google.picker.Action.CANCEL) {
    document.getElementById("msg").textContent = "Nothing was picked.";
    document.getElementById("again").hidden = false;
  }
}
function openPicker() {
  document.getElementById("again").hidden = true;
  document.getElementById("msg").textContent = "Google's picker is opening…";
  new google.picker.PickerBuilder()
    .addView(new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setSelectFolderEnabled(false))
    .setOAuthToken(cfg.token).setDeveloperKey(cfg.key).setAppId(cfg.app)
    .setCallback(done).build().setVisible(true);
}
</script>
<script>document.getElementById("pick").addEventListener("click", openPicker);</script>
<script src="https://apis.google.com/js/api.js" onload="gapi.load('picker', openPicker)"></script>
</body></html>`;
}
