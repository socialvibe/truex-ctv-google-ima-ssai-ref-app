import { TXMPlatform } from 'truex-shared/focus_manager/txm_platform';

import './video-controller.scss';
import playSvg from '../assets/play-button.svg';
import pauseSvg from '../assets/pause-button.svg';

import { AdBreak } from "./ad-break";
import { InteractiveAd } from "./interactive-ad";

const StreamEvent = google.ima.dai.api.StreamEvent;
const StreamManager = google.ima.dai.api.StreamManager;

export class VideoController {
    constructor(videoOwner, controlBarSelector, platform) {
        this.debug = false; // set to true to enable more verbose video time logging.

        this.videoOwner = document.querySelector(videoOwner);
        if (!this.videoOwner) {
            throw new Error('video owner not found: ' + videoOwner);
        }

        // The IMA SDK can steal the keyboard focus, esp if the user is clicking on ads.
        // Ensure the app focus is again in place.
        this.videoOwner.addEventListener("click", () => window.focus());

        this.video = null;
        this.hlsController = null;
        this.streamManager = null;
        this.videoStream = null;
        this.videoDuration = 0;

        this.controlBarDiv = document.querySelector(controlBarSelector);
        this.isControlBarVisible = false;
        this.showControlBarInitially = false;

        this.adIndicator = document.querySelector('.ad-indicator');

        this.playButton = this.controlBarDiv.querySelector('.play-button');
        this.playButton.innerHTML = playSvg;

        this.pauseButton = this.controlBarDiv.querySelector('.pause-button');
        this.pauseButton.innerHTML = pauseSvg;

        this.timeline = this.controlBarDiv.querySelector('.timeline');
        this.progressBar = this.controlBarDiv.querySelector('.timeline-progress');
        this.seekBar = this.controlBarDiv.querySelector('.timeline-seek');
        this.adMarkersDiv = this.controlBarDiv.querySelector('.ad-markers');

        this.timeLabel = this.controlBarDiv.querySelector('.current-time');
        this.durationLabel = this.controlBarDiv.querySelector('.duration');

        this.videoStarted = false;
        this.initialVideoTime = 0;
        this.currVideoTime = -1;
        this.seekTarget = undefined;
        this.adBreaks = [];

        this.platform = platform || new TXMPlatform();

        this.loadingSpinner = null;

        this.onControlBarClick = this.onControlBarClick.bind(this);
        this.controlBarDiv.addEventListener('click', this.onControlBarClick);

        this.onVideoTimeUpdate = this.onVideoTimeUpdate.bind(this);
        this.onVideoStarted = this.onVideoStarted.bind(this);
        this.onStreamEvent = this.onStreamEvent.bind(this);

        this.closeVideoAction = function() {}; // override as needed
    }

    controlsEnabled() {
        return this.videoStarted && this.videoOwner.classList.contains('show');
    }

    showControlBar(forceTimer) {
        this.controlBarDiv.classList.add('show');
        this.isControlBarVisible = true;
        this.refresh();

        this.stopControlBarTimer();
        if (forceTimer || !this.isPaused()) {
            this.controlBarTimer = setTimeout(() => this.hideControlBar(), 8 * 1000);
        }
    }

    hideControlBar() {
        this.controlBarDiv.classList.remove('show');
        this.isControlBarVisible = false;
        this.stopControlBarTimer();
    }

    showLoadingSpinner(visible) {
        const spinner = this.loadingSpinner;
        if (!spinner) return;
        if (visible) spinner.show();
        else spinner.hide();
    }

    // Create the video element "later" to work around some hangs and crashes, e.g. on the PS4
    startVideoLater(videoStream, showControlBar) {
        this.stopOldVideo(videoStream);
        setTimeout(() => this.startVideo(videoStream, showControlBar), 1);
    }

    startVideo(videoStream, showControlBar) {
        this.stopOldVideo(videoStream);

        this.showControlBarInitially = showControlBar || false;

        const isFirstStart = !!videoStream;
        if (videoStream) {
            this.videoStream = videoStream;
            this.adBreaks = []; // ensure ad breaks get reloaded
            this.initialVideoTime = 0; // ensure we start at the beginning
            this.hlsController = new Hls();
            console.log(`starting video: ${videoStream.title}`);
        } else {
            videoStream = this.videoStream;
            if (!videoStream) {
                throw new Error('missing video stream');
            }
        }

        this.showLoadingSpinner(true);

        const video = document.createElement('video');
        this.video = video;

        // Put the video underneath any control overlays.
        const overlay = this.videoOwner.firstChild;
        this.videoOwner.insertBefore(this.video, overlay);

        if (this.platform.isAndroid) {
            video.poster = 'noposter'; // work around grey play icon on Android TV.
        }

        video.addEventListener('playing', this.onVideoStarted);
        video.addEventListener("timeupdate", this.onVideoTimeUpdate);

        this.videoStarted = false; // set to true on the first playing event

        // We are showing our own Ad UI, so just pass in a disconnected place holder to keep the manager happy.
        const adUI = document.createElement('div');
        this.streamManager = new StreamManager(video, adUI);

        const streamEvents = [
            StreamEvent.Type.LOADED,
            StreamEvent.Type.ERROR,
            StreamEvent.Type.CUEPOINTS_CHANGED,
            StreamEvent.Type.STARTED,
            StreamEvent.Type.COMPLETE,
            StreamEvent.Type.AD_BREAK_STARTED,
            StreamEvent.Type.AD_BREAK_ENDED
        ];
        this.streamManager.addEventListener(streamEvents, this.onStreamEvent, false);

        const streamRequest = new google.ima.dai.api.VODStreamRequest();
        streamRequest.contentSourceId = videoStream.google_content_id;
        streamRequest.videoId = videoStream.google_video_id;
        streamRequest.apiKey = null; // unused since stream is not encrypted
        this.streamManager.requestStream(streamRequest);

        if (!isFirstStart) {
            this.attachVideo();
        }
    }

    stopOldVideo(newVideoStream) {
        if (this.video) {
            if (newVideoStream && this.videoStream === newVideoStream) {
                return; // already playing.
            } else {
                // Stop the existing video. (Creating a new video instance is more reliable across
                // platforms than just changing the video.src)
                this.stopVideo();
            }
        }
    }

    stopVideo() {
        console.log("stopping video");
        this.hideControlBar();

        this.showLoadingSpinner(false);

        const video = this.video;
        if (!video) return;

        this.pause();

        this.hlsController.detachMedia();
        video.removeEventListener('timeupdate', this.onVideoTimeUpdate);
        video.removeEventListener('playing', this.onVideoStarted);

        video.src = ''; // ensure actual video is unloaded (needed for PS4).

        this.videoOwner.removeChild(video); // remove from the DOM

        this.streamManager.reset();

        this.video = null;
        this.streamManager = null;
        this.seekTarget = undefined;
    }

    /**
     * Responds to a Google IMA stream event.
     * @param  {StreamEvent} e
     */
    onStreamEvent(e) {
        const streamData = e.getStreamData();
        const adProgress = streamData.adProgressData;
        const ad = e.getAd();
        var msg = 'IMA stream event: ' + e.type + ' at: ' + this.timeDebugDisplay(this.currVideoTime);
        if (ad) msg += ' for ad: ' + ad.getAdId();
        console.log(msg);
        switch (e.type) {
            case StreamEvent.Type.CUEPOINTS_CHANGED:
                if (this.adBreaks.length == 0) {
                    this.streamManager.removeEventListener(StreamEvent.Type.CUEPOINTS_CHANGED, this.onStreamEvent);
                    this.setAdBreaks(streamData.cuepoints);
                }
                break;

            case StreamEvent.Type.LOADED:
                this.hlsController.loadSource(streamData.url);
                this.hlsController.on(Hls.Events.MANIFEST_PARSED, () => this.attachVideo());
                break;

            case StreamEvent.Type.ERROR:
                break;

            case StreamEvent.Type.STARTED:
                this.startInteractiveAd(ad);
                break;

            case StreamEvent.Type.AD_BREAK_STARTED:
                // We don't strictly need to know these events since we monitor video time updates anyway.
                // this.hideControlBar();
                // this.adUI.style.display = 'block';
                // this.refresh();
                break;
            case StreamEvent.Type.AD_BREAK_ENDED:
                // this.adUI.style.display = 'none';
                // this.refresh();
                break;

            case StreamEvent.Type.AD_PROGRESS:
                // We are tracking progress via our own video time updates.
                // const timeRemaining = Math.ceil(adProgress.duration - adProgress.currentTime);
                // console.log('Ad Progress: dur: ' + adProgress.duration + ' remaining: ' + timeRemaining);
                // this.refresh();
                break;
            default:
                break;
        }
    }

    showPlayer(visible) {
        if (visible) {
            console.log("showing player");
            this.videoOwner.classList.add('show');
        } else {
            console.log("hiding player");
            this.videoOwner.classList.remove('show');
        }
    }

    attachVideo(atTime, andPlay = true) {
        if (!atTime) atTime = this.initialVideoTime;
        console.log('video attached at: ' + this.timeDebugDisplay(atTime));
        this.currVideoTime = atTime; // will be updated as video progresses
        this.hlsController.config.startPosition = atTime;
        this.hlsController.attachMedia(this.video);
        this.ensureDuration();
        if (andPlay) this.play();
    }

    stopControlBarTimer() {
        if (this.controlBarTimer) {
            clearTimeout(this.controlBarTimer);
            this.controlBarTimer = undefined;
        }
    }

    togglePlayPause() {
        if (!this.video) {
            const showControlBar = true;
            this.startVideoLater(null, showControlBar);
            return;
        }

        let forceControlBarTimeout = false;
        if (this.isPaused()) {
            forceControlBarTimeout = true
            this.play();
        } else {
            this.pause();
        }

        this.showControlBar(forceControlBarTimeout);
    }

    isPaused() {
        return !this.video || this.video.paused;
    }

    play() {
        const playNow = () => {
            if (!this.video) return;
            console.log(`play at: ${this.timeDebugDisplay(this.currVideoTime)}`);
            const playPromise = this.video.play();
            if (playPromise) {
                playPromise.catch(() => console.warn('last play request interrupted'));
            }
        };
        if (this.platform.isPS4) {
            // Work around PS4 hangs by starting playback in a separate thread.
            setTimeout(playNow, 0);
        } else {
            playNow();
        }
    }

    pause() {
        if (!this.video) return;
        console.log(`paused at: ${this.timeDebugDisplay(this.currVideoTime)}`);
        this.video.pause();
    }

    stepForward() {
        this.stepVideo(true);
    }

    stepBackward() {
        this.stepVideo(false);
    }

    stepVideo(forward) {
        if (!this.video) return; // user stepping should only happen on an active video

        const currTime = this.currVideoTime;

        if (this.hasAdBreakAt(currTime)) {
            // Don't allow user seeking during ad playback
            // Just show the control bar so the user can see the timeline.
            this.showControlBar();
            return;
        }

        let seekStep = 10; // default seek step seconds
        const seekChunks = 80; // otherwise, divide up videos in this many chunks for seek steps
        const duration = this.getPlayingVideoDuration();
        if (duration > 0) {
            const dynamicStep = Math.floor(duration / seekChunks);
            seekStep = Math.max(seekStep, dynamicStep);
        }
        if (!forward) seekStep *= -1;
        const stepFrom = this.seekTarget >= 0 ? this.seekTarget : currTime;
        const newTarget = stepFrom + seekStep;
        this.seekTo(newTarget);
    }

    rawSeekTo(newTarget) {
        const showController = false;
        const ignoreAds = true;
        this.seekTo(newTarget, showController, ignoreAds);
    }

    seekTo(newTarget, showControlBar, ignoreAds) {
        if (showControlBar === undefined) showControlBar = true; // default to showing the control bar

        const currTime = this.currVideoTime;

        // not needed, seems better to force the seek in stuck situations
        //if (currTime == newTarget) return; // already at the target

        const video = this.video;

        // We only have a max target if the video duration is known.
        const duration = video && video.duration;
        const maxTarget = duration > 0 ? duration : newTarget;

        // Don't allow seeking back to the preroll.
        const firstAdBlock = this.adBreaks[0];
        const minTarget = firstAdBlock && firstAdBlock.startTime <= 0 && !ignoreAds ? firstAdBlock.duration : 0;

        newTarget = Math.max(minTarget, Math.min(newTarget, maxTarget));

        // Skip over completed ads, but stop on uncompleted ones to force ad playback.
        var adAdjustedTarget = newTarget;
        var crossingAd = false;
        if (currTime < newTarget) {
            // Seeking forward
            for (var i in this.adBreaks) {
                const adBreak = this.adBreaks[i];
                if (newTarget < adBreak.startTime) break; // ignore future ads after the seek target
                if (adBreak.endTime <= currTime) continue; // ignore past ads

                crossingAd = true; // we will have to do the seek work around below

                if (adBreak.completed) {
                    if (adBreak.contains(newTarget)) {
                        // We have landed within an ad break on a step, skip over the completed ad break.
                        adAdjustedTarget += adBreak.duration;
                        break;
                    }
                } else {
                    // Play the ad instead of stepping over it.
                    adAdjustedTarget = adBreak.startTime;
                    break;
                }
            }
        } else {
            // Seeking backwards
            for (var i = this.adBreaks.length - 1; i >= 0; i--) {
                const adBreak = this.adBreaks[i];
                if (currTime <= adBreak.startTime) continue; // ignore unplayed future ads
                if (adBreak.endTime < newTarget) break; // ignore ads before the seek target

                crossingAd = true; // we will have to do the seek work around below

                if (adBreak.completed) {
                    if (adBreak.contains(newTarget)) {
                        // We have landed within an ad break on a step, skip over the completed ad break.
                        adAdjustedTarget -= adBreak.duration;
                        break;
                    }
                } else {
                    // Play the ad instead of stepping over it.
                    adAdjustedTarget = adBreak.startTime;
                    break;
                }
            }
        }
        if (!ignoreAds) newTarget = adAdjustedTarget;
        this.seekTarget = newTarget;
        console.log(`seek to: ${this.timeDebugDisplay(this.seekTarget)}`);

        if (video) {
            if (this.hlsController && crossingAd) {
                // The Google SDK with the Hls controller seems to lock up when seek across ad boundaries.
                // We use this work around for now.
                this.hlsController.detachMedia();
                video.currentTime = newTarget;
                this.attachVideo(newTarget);
            } else {
                video.currentTime = newTarget;
            }

        } else {
            // No video present yet, just record the desired current time for when it resumes.
            this.initialVideoTime = newTarget;
        }

        if (showControlBar) {
            this.showControlBar();
        }
    }

    onControlBarClick(event) {
        event.stopImmediatePropagation();
        event.preventDefault();

        const currTime = this.currVideoTime;
        const timelineBounds = this.timeline.getBoundingClientRect();
        const mouseX = event.clientX;
        if (mouseX < timelineBounds.left) {
            // Interpret as a play/pause toggle, in case we are clicking just beside the button.
            this.togglePlayPause();

        } else if (this.hasAdBreakAt(currTime)) {
            return;  // Don't allow user seeking during ad playback

        } else {
            const timelineX = Math.max(0, mouseX - timelineBounds.left);
            const timelineRatio = timelineX / timelineBounds.width;
            const videoDuration = this.getPlayingVideoDuration();
            const contentTargetTime = videoDuration * timelineRatio;
            this.seekTo(this.getRawVideoTimeAt(contentTargetTime));
        }
    }

    skipAdBreak(adBreak) {
        if (!adBreak) adBreak = this.getAdBreakAt(this.currVideoTime);
        if (!adBreak) return;
        adBreak.completed = true;

        console.log(`ad break ${adBreak.index} skipped to: ${this.timeDebugDisplay(adBreak.endTime)}`);
        this.hideControlBar();

        // skip a little past the end to avoid a flash of the final ad frame
        this.rawSeekTo(adBreak.endTime + 1);
        this.play();
        this.showPlayer(true);
    }

    resumeAdBreak(adBreak) {
        if (!adBreak) adBreak = this.getAdBreakAt(this.currVideoTime);
        if (!adBreak) return;
        console.log(`ad break ${adBreak.index} resumed from: ${this.timeDebugDisplay(adBreak.fallbackStartTime)}`);
        this.hideControlBar();
        this.rawSeekTo(adBreak.fallbackStartTime);
        this.play();
        this.showPlayer(true);
    }

    startInteractiveAd(googleAd) {
        const podInfo = googleAd.getAdPodInfo();
        const adBreak = this.adBreaks[podInfo.getPodIndex()];
        if (!adBreak) return;
        if (adBreak.started) return; // ad already processed
        if (adBreak.completed) {
            // Ignore ads already completed.
            this.skipAdBreak(adBreak);
            return;
        }

        // For true[X] IMA integration, the first ad in an ad break points to the interactive ad,
        // everything else are the fallback ad videos, or else non-truex ad videos.
        // So anything not an interactive ad we just let play.
        const isInteractiveAd = googleAd.getAdSystem() == 'trueX' && podInfo.getAdPosition() == 1;
        if (!isInteractiveAd) return;

        this.showPlayer(false);

        var vastConfigUrl = googleAd.getDescription();
        vastConfigUrl = vastConfigUrl && vastConfigUrl.trim();
        // for testing against the latest QA
        // vastConfigUrl = "https://qa-get.truex.com/22105de992284775a56f28ca6dac16c667e73cd0/vast/config?dimension_1=sample-video&dimension_2=0&dimension_3=sample-video&dimension_4=1234&dimension_5=evergreen&stream_position=preroll&stream_id=1234";
        if (!vastConfigUrl) return;
        if (!vastConfigUrl.startsWith('http')) {
            vastConfigUrl = 'https://' + vastConfigUrl;
        }
        if (this.platform.isTizen || this.platform.isLG) {
            // Work around user agent filtering for now until these platforms
            // are enabled on the back end.
            vastConfigUrl = vastConfigUrl.replace(/\&?user_agent=[^&]*/, '') + '&user_agent=';
        }

        adBreak.started = true;
        console.log("truex ad started: " + vastConfigUrl);

        // Start an interactive ad.
        this.hideControlBar();

        if (this.platform.isPS4) {
            this.stopVideo(); // avoid multiple videos for platforms like the PS4
        } else {
            this.pause();
        }

        // Ensure main video is logically at the fallback videos for when it resumes
        // We just need to skip over the placeholder video of this interactive ad wrapper.
        adBreak.placeHolderDuration = googleAd.getDuration();

        const ad = new InteractiveAd(vastConfigUrl, adBreak, this);
        if (this.platform.isPS4) {
            setTimeout(() => ad.start(), 1); // show the ad "later" to work around hangs/crashes on the PS4
        } else {
            ad.start();
        }

        return true; // ad started
    }

    onVideoStarted() {
        if (!this.video) return;

        this.ensureDuration();

        if (this.videoStarted) return;
        this.videoStarted = true;

        console.log('video playback started: ' + this.timeDebugDisplay(this.initialVideoTime));

        if (!this.platform.supportsInitialVideoSeek && this.initialVideoTime > 0) {
            // The initial seek is not supported, e.g. on the PS4. Do it now.
            this.currVideoTime = 0;
            this.seekTo(this.initialVideoTime);
        } else {
            this.showLoadingSpinner(false);
            if (this.showControlBarInitially) {
                const forceTimer = true;
                this.showControlBar(forceTimer);
            } else {
                this.hideControlBar();
            }
        }
    }

    onVideoTimeUpdate() {
        if (!this.video) return;
        if (!this.videoStarted) return;

        const newTime = this.video.currentTime;
        if (this.debug) console.log('video time: ' + this.timeDebugDisplay(newTime));

        const currTime = this.currVideoTime;
        if (newTime == currTime) return;
        this.currVideoTime = newTime;
        this.seekTarget = undefined;

        this.showLoadingSpinner(false);

        const adBreak = this.getAdBreakAt(newTime);
        if (adBreak) {
            if (adBreak.completed) {
                if (Math.abs(adBreak.startTime - newTime) <= 1) {
                    // Skip over already completed ads if we run into their start times.
                    this.skipAdBreak(adBreak);
                    return;
                }
            } else if (!adBreak.started) {
                // We will get Google IMA ad start events when the ad is encountered

            } else if (Math.abs(adBreak.endTime - newTime) <= 1) {
                // The user has viewed the whole ad.
                adBreak.completed = true;
            }
        }

        this.refresh();
    }

    setAdBreaks(cuePoints) {
        this.refreshAdMarkers = true;
        const childNodes = this.adMarkersDiv.children;
        for (let i = childNodes.length - 1; i >= 0; i--) {
            this.adMarkersDiv.removeChild(childNodes[i]);
        }

        this.adBreaks = cuePoints.map((cue, index) => new AdBreak(cue, index));

        console.log("ad breaks: " + this.adBreaks.map(adBreak => {
            return timeLabel(this.getPlayingVideoTimeAt(adBreak.startTime, true))
        }).join(", "));

        this.refresh();
    }

    hasAdBreakAt(rawVideoTime) {
        const adBreak = this.getAdBreakAt(rawVideoTime);
        return !!adBreak;
    }

    getAdBreakAt(rawVideoTime) {
        if (rawVideoTime === undefined) rawVideoTime = this.currVideoTime;
        for (var index in this.adBreaks) {
            const adBreak = this.adBreaks[index];
            if (adBreak.startTime <= rawVideoTime && rawVideoTime < adBreak.endTime) {
                return adBreak;
            }
        }
        return undefined;
    }

    // We assume ad videos are stitched into the main video.
    getPlayingVideoTimeAt(rawVideoTime, skipAds) {
        let result = rawVideoTime;
        for (var index in this.adBreaks) {
            const adBreak = this.adBreaks[index];
            if (rawVideoTime < adBreak.startTime) break; // future ads don't affect things
            if (adBreak.contains(rawVideoTime)) {
                const fallbackStart = adBreak.fallbackStartTime;
                if (!skipAds && rawVideoTime >= fallbackStart) {
                    // Show the position within the fallback ads.
                    return rawVideoTime - fallbackStart;
                } else {
                    // Correct to show the content position at the ad break start.
                    return result - (rawVideoTime - adBreak.startTime);
                }
            } else if (adBreak.endTime <= rawVideoTime) {
                // Discount the ad duration.
                result -= adBreak.duration;
            }
        }
        return result;
    }

    ensureDuration() {
        if (!this.videoDuration && this.video && this.video.duration > 0) {
            this.videoDuration = this.video.duration;
        }
    }

    getPlayingVideoDuration() {
        const duration = this.videoDuration || this.video && this.video.duration || 0;
        return this.getPlayingVideoTimeAt(duration);
    }

    getRawVideoTimeAt(contentVideoTime) {
        let result = contentVideoTime;
        let previousAdBreakDurations = 0;
        for (var index in this.adBreaks) {
            const adBreak = this.adBreaks[index];
            const adBreakContentStart = adBreak.startTime - previousAdBreakDurations;
            if (contentVideoTime < adBreakContentStart) break; // future ads don't affect things
            if (adBreakContentStart < contentVideoTime) {
                result += adBreak.duration;
            }
            previousAdBreakDurations += adBreak.duration;
        }
        return result;
    }

    timeDebugDisplay(rawVideoTime) {
        const displayTime = this.getPlayingVideoTimeAt(rawVideoTime, true);
        var result = timeLabel(displayTime);
        const adBreak = this.getAdBreakAt(rawVideoTime);
        if (adBreak) {
            const adTime = this.getPlayingVideoTimeAt(rawVideoTime, false);
            result += ' (adBreak ' + adBreak.index + ' ' + timeLabel(adTime) + ')';
        }
        result += ' (raw ' + timeLabel(rawVideoTime) + ')'
        return result;
    }

    refresh() {
        const currTime = this.currVideoTime;

        const adBreak = this.getAdBreakAt(currTime);
        if (adBreak) {
            this.adIndicator.classList.add('show');
        } else {
            this.adIndicator.classList.remove('show');
        }

        if (!this.isControlBarVisible) {
            // other updates don't matter unless the control bar is visible
            return;
        }

        if (this.isPaused()) {
            // Next play input action will resume playback
            this.playButton.classList.add('show');
            this.pauseButton.classList.remove('show');
        } else {
            // Next play input action will pause playback
            this.playButton.classList.remove('show');
            this.pauseButton.classList.add('show');
        }

        const durationToDisplay = adBreak ? adBreak.fallbackDuration : this.getPlayingVideoDuration();

        function percentage(time) {
            const result = durationToDisplay > 0 ? (time / durationToDisplay) * 100 : 0;
            return `${result}%`;
        }

        const seekTarget = this.seekTarget;
        let currTimeToDisplay = this.getPlayingVideoTimeAt(currTime);
        let timeToDisplay = currTimeToDisplay;
        if (seekTarget >= 0) {
            timeToDisplay = this.getPlayingVideoTimeAt(seekTarget);
            const seekTargetDiff = Math.abs(currTimeToDisplay - timeToDisplay);
            this.seekBar.style.width = percentage(seekTargetDiff);
            if (currTimeToDisplay <= timeToDisplay) {
                this.seekBar.style.left = percentage(currTimeToDisplay);
            } else {
                this.seekBar.style.left = percentage(currTimeToDisplay - seekTargetDiff);
            }
            this.seekBar.classList.add('show');

        } else {
            this.seekBar.classList.remove('show');
        }

        this.progressBar.style.width = percentage(timeToDisplay);
        this.durationLabel.innerText = timeLabel(durationToDisplay);

        this.timeLabel.innerText = timeLabel(timeToDisplay);
        this.timeLabel.style.left = percentage(timeToDisplay);

        if (adBreak) {
            this.adMarkersDiv.classList.remove('show');
        } else {
            if (this.refreshAdMarkers && durationToDisplay > 0) {
                this.refreshAdMarkers = false;
                this.adBreaks.forEach(adBreak => {
                    const marker = document.createElement('div');
                    marker.classList.add('ad-break');
                    const skipAds = true;
                    const adPlaytime = this.getPlayingVideoTimeAt(adBreak.startTime, skipAds);
                    marker.style.left = percentage(adPlaytime);
                    this.adMarkersDiv.appendChild(marker);
                });
            }
            this.adMarkersDiv.classList.add('show');
        }
    }
}

function timeLabel(time) {
    time = Math.round(time);
    const seconds = time % 60;
    time /= 60;
    const minutes = time % 60;
    time /= 60;
    const hours = time;

    const result = pad(minutes) + ':' + pad(seconds);
    if (hours >= 1) return Math.floor(hours) + ':' + result;
    return result;
}

function pad(value) {
    value = Math.floor(value || 0);
    return (value < 10) ? '0' + value : value.toString();
}
