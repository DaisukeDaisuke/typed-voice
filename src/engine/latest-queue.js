export class LatestRequestQueue {
  constructor(maxQueued = 2) {
    if (!Number.isInteger(maxQueued) || maxQueued < 1) {
      throw new TypeError("maxQueued must be a positive integer");
    }
    this.maxQueued = maxQueued;
    this.items = [];
  }

  enqueue(request) {
    const replaced = [];
    this.items = this.items.filter((item) => {
      if (item.utteranceId === request.utteranceId) {
        replaced.push(item);
        return false;
      }
      return true;
    });
    this.items.push(request);

    const dropped = [];
    while (this.items.length > this.maxQueued) {
      dropped.push(this.items.shift());
    }
    return { replaced, dropped };
  }

  removeOlder(utteranceId, generation) {
    const removed = [];
    this.items = this.items.filter((item) => {
      if (item.utteranceId === utteranceId && item.generation < generation) {
        removed.push(item);
        return false;
      }
      return true;
    });
    return removed;
  }

  shift() {
    return this.items.shift() ?? null;
  }

  get length() {
    return this.items.length;
  }
}