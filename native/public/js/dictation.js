// Hold-to-talk into the prompt. Audio stays on this origin; the server
// transcribes with the OpenAI key on disk. The key never enters the browser.

export function createDictation(input) {
  let live = false;
  let recorder = null;
  let chunks = [];
  let stream = null;
  let base = "";
  let pending = null;

  function mime() {
    for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
  }

  function append(text) {
    if (!text) return;
    const glue = base && !/\s$/.test(base) ? " " : "";
    input.value = base + glue + text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function transcribe(blob) {
    const response = await fetch("/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    if (!response.ok) throw new Error("transcribe failed");
    const data = await response.json();
    return data.text || "";
  }

  async function start() {
    if (live || pending) return false;
    live = true;
    base = input.value;
    chunks = [];
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = mime();
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.start(200);
      input.dataset.dictating = "1";
      return true;
    } catch {
      live = false;
      stream?.getTracks().forEach(track => track.stop());
      stream = recorder = null;
      return false;
    }
  }

  function stop() {
    if (!live && !recorder) return;
    live = false;
    delete input.dataset.dictating;
    const rec = recorder;
    recorder = null;
    const tracks = stream;
    stream = null;
    if (!rec || rec.state === "inactive") {
      tracks?.getTracks().forEach(track => track.stop());
      return;
    }
    pending = new Promise(resolve => {
      rec.onstop = resolve;
      try { rec.stop(); } catch { resolve(); }
    }).then(async () => {
      tracks?.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      chunks = [];
      if (blob.size < 200) return;
      append(await transcribe(blob));
    }).catch(() => {}).finally(() => { pending = null; });
  }

  return { start, stop, get live() { return live; } };
}

export function attachHoldSpace(input, dictation) {
  let timer = 0;
  const arm = () => {
    timer = setTimeout(() => {
      timer = 0;
      void dictation.start();
    }, 220);
  };
  const cancel = () => { clearTimeout(timer); timer = 0; };
  input.addEventListener("keydown", event => {
    if (event.key !== " " || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if (dictation.live || event.repeat) { event.preventDefault(); return; }
    arm();
  });
  input.addEventListener("keyup", event => {
    if (event.key !== " ") return;
    cancel();
    if (dictation.live) { event.preventDefault(); dictation.stop(); }
  });
  input.addEventListener("blur", () => { cancel(); dictation.stop(); });
}
