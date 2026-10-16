/**
 * Module quản lý âm thanh cảnh báo bằng Web Audio API
 * - Phát âm thanh lặp lại đều đặn (beep beep)
 * - Tối đa 30 giây thì tự động dừng
 * - Có bộ đếm giây hiển thị trên giao diện
 * - Nút DỪNG THÔNG BÁO lập tức ngắt toàn bộ âm thanh và hủy timer
 * - Xử lý AudioContext autoplay policy của trình duyệt
 */
class AlertAudioManager {
  constructor(options = {}) {
    this.audioCtx = null;
    this.isPlaying = false;
    this.intervalId = null;
    this.timeoutId = null;
    this.countdownTimer = null;
    this.maxDurationSeconds = options.maxDurationSeconds || 30;
    this.remainingSeconds = this.maxDurationSeconds;
    this.onTick = options.onTick || null;
    this.onStop = options.onStop || null;
  }

  initContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  /**
   * Phát một xung âm thanh (beep) tần số 880Hz -> 659Hz
   */
  playBeep() {
    if (!this.audioCtx) return;

    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, this.audioCtx.currentTime); // A5
      osc.frequency.exponentialRampToValueAtTime(659, this.audioCtx.currentTime + 0.15); // E5

      gain.gain.setValueAtTime(0.3, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.25);
    } catch (e) {
      console.warn('[Audio] Lỗi phát âm thanh:', e);
    }
  }

  /**
   * Bắt đầu vòng lặp phát cảnh báo (beep 2 lần mỗi giây)
   */
  startAlert() {
    this.initContext();
    if (this.isPlaying) {
      // Đã đang phát cảnh báo, không kích hoạt nhiều âm thanh chồng lên nhau
      return;
    }

    this.isPlaying = true;
    this.remainingSeconds = this.maxDurationSeconds;

    if (this.onTick) this.onTick(this.remainingSeconds);

    // Phát ngay tiếng beep đầu tiên
    this.playBeep();
    setTimeout(() => { if (this.isPlaying) this.playBeep(); }, 200);

    // Lặp lại đều đặn mỗi 1000ms
    this.intervalId = setInterval(() => {
      if (!this.isPlaying) return;
      this.playBeep();
      setTimeout(() => { if (this.isPlaying) this.playBeep(); }, 200);
    }, 1000);

    // Bộ đếm đếm lùi từng giây
    this.countdownTimer = setInterval(() => {
      this.remainingSeconds--;
      if (this.onTick) this.onTick(this.remainingSeconds);
      if (this.remainingSeconds <= 0) {
        this.stopAlert('TIMEOUT');
      }
    }, 1000);

    // Hủy tự động sau 30 giây
    this.timeoutId = setTimeout(() => {
      this.stopAlert('TIMEOUT');
    }, this.maxDurationSeconds * 1000);
  }

  /**
   * Dừng cảnh báo âm thanh
   * @param {'STOPPED' | 'TIMEOUT'} reason
   */
  stopAlert(reason = 'STOPPED') {
    if (!this.isPlaying) return;

    this.isPlaying = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    this.remainingSeconds = 0;
    if (this.onTick) this.onTick(0);

    if (this.onStop) {
      this.onStop(reason);
    }
  }

  /**
   * Thử nghiệm âm thanh 1 lần (dành cho nút "Kiểm tra âm thanh")
   */
  testBeep() {
    this.initContext();
    this.playBeep();
    setTimeout(() => this.playBeep(), 200);
  }
}

window.AlertAudioManager = AlertAudioManager;
