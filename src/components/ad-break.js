/**
 * Describes a single ad break timestance that covers 1 or more fallback ad videos in the main video
 * (ads are assumed to be sitched in), that furthermore describes a true[X] interactive ad to show
 * over top of the main video when the ad break is encountered during playback.
 */
export class AdBreak {
    constructor(cuePoint, index) {
        this.index = index;
        this.startTime = cuePoint.start;
        this.endTime = cuePoint.end;
        this.started = false;
        this.completed = false;

        // The length of the truex placeholder video.
        this.placeHolderDuration = 0;
    }

    get duration() {
        return this.endTime - this.startTime;
    }

    get fallbackStartTime() {
        return this.startTime + this.placeHolderDuration;
    }

    get fallbackDuration() {
        return this.duration - this.placeHolderDuration;
    }
}
