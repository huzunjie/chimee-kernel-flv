import {CustEvent} from 'chimee-helper';
import MseContriller from './core/mse-controller';
import Transmuxer from './core/transmuxer';
import defaultConfig from './config';
import {throttle, deepAssign, Log, UAParser} from 'chimee-helper';
/**
 * flv controller
 * @export
 * @class Flv
 */
export default class Flv extends CustEvent {

  static isSupport () {
    const parser = new UAParser();
    const info = parser.getBrowser();
    if(info.name === 'Safari' && parseInt(info.major) < 10) {
      return false;
    }
    if(window.MediaSource && window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.640020,mp4a.40.2"')) {
      return true;
    } else {
      return false;
    }
  }

  static get version () {
    return __VERSION__;
  }

  /**
	 * flv Wrapper
	 * @param {any} wrap videoElement
	 * @param {any} option
	 * @class Flv
	 */
	constructor (videodom, config) {
    super();
    this.tag = 'flv-player';
    this.video = videodom;
    this.box = 'flv';
    this.timer = null;
    this.config = deepAssign({}, defaultConfig, config);
    this.requestSetTime = false;
    this.bindEvents();
    this.attachMedia();
  }
  /**
   * internal set currentTime
   * @memberof Flv
   */
  internalPropertyHandle () {
    if(!Object.getOwnPropertyDescriptor) {
      return;
    }
    const _this = this;
    const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');

    Object.defineProperty(this.video, 'currentTime', {
      get: ()=> {
        return time.get.call(_this.video);
      },
      set: (t)=> {
        if(!_this.currentTimeLock) {
          throw new Error('can not set currentTime by youself');
        } else {
          return time.set.call(_this.video, t);
        }
      }
    });
  }

  /**
   * bind events
   * @memberof Flv
   */
  bindEvents () {
    if(this.video) {
      this.video.addEventListener('canplay', () => {
        if(this.config.isLive && this.config.autoplay) {
          this.video.play();
        }
        if(this.config.lockInternalProperty) {
          this.internalPropertyHandle();
        }
      });
    }
  }

  /**
   * new mediaSource
   * @memberof Flv
   */
  attachMedia () {
    this.mediaSource = new MseContriller(this.video, this.config);

    this.mediaSource.on('error', ()=>{
      if(this.transmuxer) {
        this.transmuxer.pause();
      }
    });
    this.mediaSource.on('bufferFull', ()=>{
      this.pauseTransmuxer();
    });
    this.mediaSource.on('updateend', ()=>{
      this.onmseUpdateEnd();
    });
  }

  /**
   * load
   * @param {string} video url
   * @memberof Flv
   */
  load (src) {
    if(src) {
      this.config.src = src;
    }
    this.transmuxer = new Transmuxer(this.mediaSource, this.config);
    this.transmuxer.on('mediaSegment', (handle)=> {
      this.mediaSource.emit('mediaSegment', handle.data);
      // this.onmseUpdateEnd();
    });

    this.transmuxer.on('mediaSegmentInit', (handle)=> {
      this.mediaSource.emit('mediaSegmentInit', handle.data);
    });

    this.transmuxer.on('error', (handle)=> {
      this.emit('error', handle.data);
    });
    this.transmuxer.on('mediaInfo', (mediaInfo)=>{
      if(!this.mediaInfo) {
        this.mediaInfo = mediaInfo;
        this.emit('mediaInfo', mediaInfo);
        this.mediaSource.init(mediaInfo);
        this.video.src = URL.createObjectURL(this.mediaSource.mediaSource);
        this.video.addEventListener('seeking', throttle(this._seek.bind(this), 200, {leading: false}));
      }
    });
    this.transmuxer.loadSource();
  }

  /**
   * seek in buffered
   * @param {number} seek time
   * @memberof Flv
   */
  isTimeinBuffered (seconds) {
    const buffered = this.video.buffered;
    for (let i = 0; i < buffered.length; i++) {
      const from = buffered.start(i);
      const to = buffered.end(i);
      if (seconds >= from && seconds < to) {
        return true;
      }
    }
    return false;
  }

  /**
   * get current buffer end
   * @memberof Flv
   */
  getCurrentBufferEnd () {
    const buffered = this.video.buffered;
    const currentTime = this.video.currentTime;
    let currentRangeEnd = 0;

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (start <= currentTime && currentTime < end) {
        currentRangeEnd = end;
        return currentRangeEnd;
      }
    }
  }
  /**
   * _seek
   * @param {number} seek time
   * @memberof Flv
   */
  _seek (seconds) {
    this.currentTimeLock = true;
    let currentTime = seconds && !isNaN(seconds) ? seconds : this.video.currentTime;
    if(this.requestSetTime) {
      this.requestSetTime = false;
      this.currentTimeLock = false;
      return;
    }
    if(this.isTimeinBuffered(currentTime)) {
      if(this.config.alwaysSeekKeyframe) {
        const nearlestkeyframe = this.transmuxer.getNearlestKeyframe(Math.floor(currentTime * 1000));
        if (nearlestkeyframe) {
          this.requestSetTime = true;
          this.video.currentTime = nearlestkeyframe.keyframetime / 1000;
        }
      }
    } else {
      Log.verbose(this.tag, 'do seek');
      this.transmuxer.pause();
      const nearlestkeyframe = this.transmuxer.getNearlestKeyframe(Math.floor(currentTime * 1000));
      currentTime = nearlestkeyframe.keyframetime / 1000;
      this.transmuxer.seek(nearlestkeyframe);
      this.mediaSource.seek(currentTime);
      this.requestSetTime = true;
      this.video.currentTime = currentTime;
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.currentTimeLock = false;
    return currentTime;
  }

  /**
   * mediaSource updateend
   * @memberof Flv
   */
  onmseUpdateEnd () {
    if (this.config.isLive) {
      return;
    }
    const currentBufferEnd = this.getCurrentBufferEnd();
    const currentTime = this.video.currentTime;
    if (currentBufferEnd >= currentTime + this.config.lazyLoadMaxDuration && this.timer === null) {
      Log.verbose(this.tag, 'Maximum buffering duration exceeded, suspend transmuxing task');
      this.pauseTransmuxer();
    }
  }

  /**
   * heartbeat
   * @memberof Flv
   */
  heartbeat () {
    const currentTime = this.video.currentTime;
    const buffered = this.video.buffered;

    let needResume = false;

    for (let i = 0; i < buffered.length; i++) {
      const from = buffered.start(i);
      const to = buffered.end(i);
      if (currentTime >= from && currentTime < to) {
        if (currentTime >= to - this.config.lazyLoadRecoverDuration) {
          needResume = true;
        }
        break;
      }
    }

    if (needResume) {
      window.clearInterval(this.timer);
      this.timer = null;
      Log.verbose(this.tag, 'Continue loading from paused position');
      this.transmuxer.resume();
      this.mediaSource.resume();
    }
  }

  /**
   * pause transmuxer
   * @memberof Flv
   */
  pauseTransmuxer () {
    this.transmuxer.pause();
    if(!this.timer) {
      this.timer = setInterval(this.heartbeat.bind(this), 1000);
    }
  }

  resume () {
    this._seek(0);
  }

  /**
   * destroy
   * @memberof Flv
   */
  destroy () {
    if(this.video) {
      URL.revokeObjectURL(this.video.src);
      this.video.src = '';
      this.video.removeAttribute('src');
      this.transmuxer.destroy();
      this.transmuxer = null;
      this.mediaSource.destroy();
      this.mediaSource = null;
    }
  }

  seek (seconds) {
    return this._seek(seconds);
  }

  play () {
    return this.video.play();
  }

  pause () {
    return this.video.pause();
  }

  refresh () {
    this.transmuxer.refresh();
  }
}
