import type { Config } from '@/app/config';

export interface CameraInfo {
  deviceId: string;
  label: string;
}

/**
 * Owns the <video> element and its getUserMedia stream.
 *
 * Requests 640×480: MediaPipe resizes frames to 224² internally, so a larger
 * capture only costs exposure time and USB bandwidth. `deviceId` lets an
 * external webcam or an iPhone (macOS Continuity Camera) replace the lid camera.
 */
export class Camera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  /** Bumped by start()/stop() so a start that was superseded mid-await backs off. */
  private generation = 0;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
  }

  get width(): number {
    return this.video.videoWidth;
  }

  get height(): number {
    return this.video.videoHeight;
  }

  /** videoWidth / videoHeight. Display-space x ranges over [0, aspect]. */
  get aspect(): number {
    return this.video.videoHeight > 0 ? this.video.videoWidth / this.video.videoHeight : 4 / 3;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  /** The deviceId the browser actually opened (may differ from the request). */
  get deviceId(): string {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
  }

  /**
   * Open the camera. If stop() or another start() happens while getUserMedia is
   * pending, the late stream is released and this call returns without touching
   * the video element (which may by then belong to a newer stream).
   */
  async start(opts: Config['camera']): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const video: MediaTrackConstraints = {
      width: { ideal: opts.width },
      height: { ideal: opts.height },
      frameRate: { ideal: opts.idealFps },
    };
    if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
    else video.facingMode = 'user';

    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('video element failed to load the camera stream'));
      };
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA) return onLoaded();
      this.video.addEventListener('loadedmetadata', onLoaded);
      this.video.addEventListener('error', onError);
    });

    await this.video.play();
  }

  stop(): void {
    this.generation++;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      // Only detach our own stream: another Camera may share this element.
      if (this.video.srcObject === this.stream) this.video.srcObject = null;
      this.stream = null;
    }
  }

  /**
   * Video input devices. Labels are only populated once camera permission has
   * been granted, so call this after `start()` for a useful picker.
   */
  static async list(): Promise<CameraInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }
}
