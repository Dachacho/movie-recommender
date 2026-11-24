import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from './download';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('downloadTextFile', () => {
  it('clicks a temporary anchor with the blob URL and filename, then cleans up', async () => {
    const createdUrl = 'blob:movie-recommender-download';
    const blobs: Blob[] = [];
    const anchors: HTMLAnchorElement[] = [];
    let anchorWasAttached = false;

    URL.createObjectURL = vi.fn((object: Blob | MediaSource) => {
      if (!(object instanceof Blob)) {
        throw new Error('expected a blob');
      }

      blobs.push(object);

      return createdUrl;
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchors.push(this);
      anchorWasAttached = document.body.contains(this);
    });

    downloadTextFile('letterboxd-ratings.csv', 'Date,Name\n2024-01-01,Arrival', 'text/csv');

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(createdUrl);

    const blob = blobs[0];
    const anchor = anchors[0];

    expect(blob).toBeInstanceOf(Blob);
    expect(anchor).toBeInstanceOf(HTMLAnchorElement);

    if (blob === undefined || anchor === undefined) {
      throw new Error('expected the download to create a blob and click an anchor');
    }

    expect(anchor.download).toBe('letterboxd-ratings.csv');
    expect(anchor.href).toBe(createdUrl);
    expect(anchorWasAttached).toBe(true);
    expect(document.querySelector('a')).toBeNull();
    expect(blob.type).toBe('text/csv');
    await expect(blob.text()).resolves.toBe('Date,Name\n2024-01-01,Arrival');
  });
});
