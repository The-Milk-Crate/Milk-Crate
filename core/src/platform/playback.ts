/** How a listener plays a track. A tagged union by `method`. Mirrors PlaybackGrant. */
export type PlaybackGrant =
  | { method: "signed_url"; trackId: string; url: string; expiresAt: string }
  | {
      method: "cloudfront_cookies";
      trackId: string;
      streamUrl: string;
      cookies: { name: string; value: string }[];
      expiresAt: string;
    };
