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
        this.duration = cuePoint.end - cuePoint.start;
        this.started = false;
        this.completed = false;
    }
}
