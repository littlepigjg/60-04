class PlaybackManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._dpr = window.devicePixelRatio || 1;

    this.actionLog = [];
    this.totalDuration = 0;

    this.currentTime = 0;
    this.playing = false;
    this.speed = 1;
    this._rafId = null;
    this._lastFrameTime = 0;

    this._snapshotCache = [];
    this._snapshotInterval = 2000;
    this._lastSnapshotIdx = -1;

    this.onTimeUpdate = null;
    this.onPlayStateChange = null;
    this.onLoad = null;

    this._annotationsAtTime = [];
  }

  loadActionLog(actionLog, duration) {
    this.stop();
    this.actionLog = actionLog || [];
    this.totalDuration = duration || 0;
    this.currentTime = 0;
    this._annotationsAtTime = [];
    this._buildSnapshots();
    this.seek(0);
    if (this.onLoad) this.onLoad(this.totalDuration);
  }

  _buildSnapshots() {
    this._snapshotCache = [];
    let state = [];
    let logIdx = 0;

    const steps = Math.max(1, Math.ceil(this.totalDuration / this._snapshotInterval));

    for (let i = 0; i <= steps; i++) {
      const t = i * this._snapshotInterval;
      while (logIdx < this.actionLog.length && this.actionLog[logIdx].time <= t) {
        state = this._applyEvent(state, this.actionLog[logIdx]);
        logIdx++;
      }
      this._snapshotCache.push({ time: t, state: state.map(a => JSON.parse(JSON.stringify(a))) });
    }
  }

  _applyEvent(annotations, event) {
    if (event.type === 'add') {
      const existing = annotations.findIndex(a => a.id === event.data.id);
      if (existing >= 0) {
        annotations[existing] = event.data;
      } else {
        annotations.push(event.data);
      }
    } else if (event.type === 'delete') {
      annotations = annotations.filter(a => a.id !== event.id);
    } else if (event.type === 'clear') {
      annotations = [];
    }
    return annotations;
  }

  _findSnapshotIndex(time) {
    let lo = 0, hi = this._snapshotCache.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this._snapshotCache[mid].time <= time) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  _computeStateAtTime(time) {
    if (!this.actionLog.length) return [];
    if (time <= 0) return [];

    const snapIdx = this._findSnapshotIndex(time);
    const snapshot = this._snapshotCache[snapIdx];
    let state = snapshot.state.map(a => JSON.parse(JSON.stringify(a)));

    let logStart = 0;
    for (let i = 0; i < this.actionLog.length; i++) {
      if (this.actionLog[i].time > snapshot.time) {
        logStart = i;
        break;
      }
      if (i === this.actionLog.length - 1) logStart = this.actionLog.length;
    }

    for (let i = logStart; i < this.actionLog.length; i++) {
      const event = this.actionLog[i];
      if (event.time > time) break;
      state = this._applyEvent(state, event);
    }

    return state;
  }

  play() {
    if (this.playing) return;
    if (this.currentTime >= this.totalDuration) {
      this.currentTime = 0;
    }
    this.playing = true;
    this._lastFrameTime = performance.now();
    this._tick();
    if (this.onPlayStateChange) this.onPlayStateChange(true);
  }

  pause() {
    this.playing = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.onPlayStateChange) this.onPlayStateChange(false);
  }

  stop() {
    this.pause();
    this.currentTime = 0;
  }

  togglePlay() {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  setSpeed(s) {
    this.speed = s;
  }

  seek(time) {
    this.currentTime = Math.max(0, Math.min(time, this.totalDuration));
    this._annotationsAtTime = this._computeStateAtTime(this.currentTime);
    this.render();
    if (this.onTimeUpdate) this.onTimeUpdate(this.currentTime);
  }

  seekPercent(pct) {
    this.seek(pct * this.totalDuration);
  }

  stepForward(ms) {
    this.seek(this.currentTime + (ms || 1000));
  }

  stepBackward(ms) {
    this.seek(this.currentTime - (ms || 1000));
  }

  _tick() {
    if (!this.playing) return;

    const now = performance.now();
    const delta = (now - this._lastFrameTime) * this.speed;
    this._lastFrameTime = now;

    this.currentTime += delta;

    if (this.currentTime >= this.totalDuration) {
      this.currentTime = this.totalDuration;
      this._annotationsAtTime = this._computeStateAtTime(this.currentTime);
      this.render();
      if (this.onTimeUpdate) this.onTimeUpdate(this.currentTime);
      this.pause();
      return;
    }

    this._annotationsAtTime = this._computeStateAtTime(this.currentTime);
    this.render();
    if (this.onTimeUpdate) this.onTimeUpdate(this.currentTime);

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  render() {
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this._annotationsAtTime.forEach(a => this._drawAnnotation(a, rect));
  }

  _drawAnnotation(a, rect) {
    const W = rect.width, H = rect.height;
    const toPx = (nx, ny) => ({ x: nx * W, y: ny * H });

    this.ctx.save();
    this.ctx.strokeStyle = a.color;
    this.ctx.fillStyle = a.color;
    this.ctx.lineWidth = a.stroke || 3;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    const s = toPx(a.startX, a.startY);
    const e = toPx(a.endX, a.endY);

    if (a.type === 'pen' && a.points) {
      this.ctx.beginPath();
      a.points.forEach((p, i) => {
        const pt = toPx(p.x, p.y);
        if (i === 0) this.ctx.moveTo(pt.x, pt.y);
        else this.ctx.lineTo(pt.x, pt.y);
      });
      this.ctx.stroke();
    } else if (a.type === 'line') {
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, s.y);
      this.ctx.lineTo(e.x, e.y);
      this.ctx.stroke();
    } else if (a.type === 'arrow') {
      this._drawArrow(s.x, s.y, e.x, e.y);
    } else if (a.type === 'circle') {
      const cx = (s.x + e.x) / 2;
      const cy = (s.y + e.y) / 2;
      const rx = Math.abs(e.x - s.x) / 2;
      const ry = Math.abs(e.y - s.y) / 2;
      this.ctx.beginPath();
      this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      this.ctx.stroke();
    } else if (a.type === 'rect') {
      const x = Math.min(s.x, e.x);
      const y = Math.min(s.y, e.y);
      const w = Math.abs(e.x - s.x);
      const h = Math.abs(e.y - s.y);
      this.ctx.strokeRect(x, y, w, h);
    }

    this.ctx.restore();
  }

  _drawArrow(x1, y1, x2, y2) {
    const headLen = 14 + (this.ctx.lineWidth || 3) * 2;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
    this.ctx.beginPath();
    this.ctx.moveTo(x2, y2);
    this.ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    this.ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    this.ctx.closePath();
    this.ctx.fill();
  }

  setupCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this._dpr;
    this.canvas.height = rect.height * this._dpr;
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    this.render();
  }

  formatTime(ms) {
    if (!ms && ms !== 0) return '00:00';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
  }
}

window.PlaybackManager = PlaybackManager;
