import html2canvas from "./html2canvas-pro.esm.js";

export async function capturePng() {
  const scale = Math.min(2, devicePixelRatio || 1);
  const canvas = await html2canvas(document.documentElement, {
    logging: false,
    useCORS: true,
    scale,
    width: innerWidth,
    height: innerHeight,
    windowWidth: innerWidth,
    windowHeight: innerHeight,
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#111",
  });
  const png = await new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("png failed")), "image/png");
  });
  const buffer = new Uint8Array(await png.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return { mime: "image/png", data: btoa(binary), width: canvas.width, height: canvas.height };
}
