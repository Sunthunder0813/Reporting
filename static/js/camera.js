const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const camLoading = document.getElementById("cam-loading");
const errorBox = document.getElementById("cam-error");
const captureBtn = document.getElementById("capture-btn");
const retakeBtn = document.getElementById("retake-btn");
const confirmBtn = document.getElementById("confirm-btn");
const retryBtn = document.getElementById("retry-btn");

let stream = null;
let snapshotDataUrl = null;

async function startCamera() {
  // Reset state in case this is a retry after a previous failure.
  camLoading.classList.remove("hidden");
  camLoading.textContent = "Starting camera…";
  errorBox.classList.add("hidden");
  retryBtn.classList.add("hidden");
  captureBtn.classList.add("hidden");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;

    // Wait for the stream to actually have a frame ready, not just for
    // getUserMedia() to resolve -- on some phones the promise resolves
    // before the first frame is decoded, and un-hiding the shutter
    // button too early lets you capture a black frame.
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.onloadeddata = resolve;
    });

    camLoading.classList.add("hidden");
    captureBtn.classList.remove("hidden");
  } catch (err) {
    camLoading.classList.add("hidden");
    errorBox.textContent =
      "Couldn't access your camera. Please allow camera permission and try again.";
    errorBox.classList.remove("hidden");
    retryBtn.classList.remove("hidden");
  }
}

function takeSnapshot() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // mirror horizontally to match the on-screen preview
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);
  snapshotDataUrl = canvas.toDataURL("image/jpeg", 0.9);

  video.classList.add("hidden");
  canvas.classList.remove("hidden");

  captureBtn.classList.add("hidden");
  retakeBtn.classList.remove("hidden");
  confirmBtn.classList.remove("hidden");
}

function retake() {
  snapshotDataUrl = null;
  video.classList.remove("hidden");
  canvas.classList.add("hidden");

  captureBtn.classList.remove("hidden");
  retakeBtn.classList.add("hidden");
  confirmBtn.classList.add("hidden");
}

async function confirmPhoto() {
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Uploading...";

  try {
    const res = await fetch("/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: snapshotDataUrl }),
    });
    const data = await res.json();
    if (data.ok) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      window.location.href = data.redirect;
    } else {
      throw new Error(data.error || "upload_failed");
    }
  } catch (err) {
    errorBox.textContent = "Upload failed. Please try again.";
    errorBox.classList.remove("hidden");
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm & Join";
  }
}

captureBtn.addEventListener("click", takeSnapshot);
retakeBtn.addEventListener("click", retake);
confirmBtn.addEventListener("click", confirmPhoto);
retryBtn.addEventListener("click", startCamera);

startCamera();