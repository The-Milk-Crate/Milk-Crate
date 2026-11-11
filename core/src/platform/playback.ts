/** The part of a read grant that depends on the platform. A tagged union by `method`. */
export type ReadGrantBody =
  | { method: "signed_url"; url: string; expiresAt: string }
  | {
      method: "cloudfront_cookies";
      streamUrl: string;
      cookies: { name: string; value: string }[];
      expiresAt: string;
    };

/** How a listener plays a track. Mirrors PlaybackGrant. */
export type PlaybackGrant = ReadGrantBody & { trackId: string };

/** How to read a release's cover art. Mirrors CoverGrant. */
export type CoverGrant = ReadGrantBody & { releaseId: string };
