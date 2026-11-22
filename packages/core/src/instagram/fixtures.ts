/**
 * Meta's Instagram webhook bodies (Instagram API with Instagram Login) as its docs show them, read 2026-11-22. Used by
 * tests here, by the API's tests and by the fake Instagram Graph. To verify against the test account.
 */
export const IG_ACCOUNT = "17841400000000001";
export const IG_ACCOUNT_B = "17841400000000002";
export const IGSID = "6512000000000001";
export const COMMENT_ID = "17990000000000001";
export const MEDIA_ID = "17980000000000001";

const ms = (iso: string) => Date.parse(iso);

type Messaging = Record<string, unknown>;

/** One `messaging` item inside the envelope Meta sends for the account. */
export const igEnvelope = (items: Messaging[], account = IG_ACCOUNT) => ({
  object: "instagram",
  entry: [{ id: account, time: ms("2026-11-22T06:00:01Z"), messaging: items }],
});

const between = (o: { from?: string; to?: string; at?: string }) => ({
  sender: { id: o.from ?? IGSID },
  recipient: { id: o.to ?? IG_ACCOUNT },
  timestamp: ms(o.at ?? "2026-11-22T06:00:00Z"),
});

/** A DM a person sent to the business. */
export const igDm = (
  o: { mid?: string; text?: string; at?: string; from?: string; account?: string } & Record<
    string,
    unknown
  > = {},
) => {
  const { mid = "aWdfMID1", at, from, account, ...rest } = o;
  // `text: undefined` means a message with no words (a photo, a mention): only a missing key takes the default.
  const { text, ...extra } = "text" in rest ? rest : { ...rest, text: "Hi, is the course still open?" };
  return igEnvelope(
    [
      {
        ...between({ from, to: account ?? IG_ACCOUNT, at }),
        message: { mid, ...(text === undefined ? {} : { text }), ...extra },
      },
    ],
    account,
  );
};

/** A message the business sent from the Instagram app (or through the API): the person is the recipient. */
export const igEcho = (o: { mid?: string; text?: string; at?: string } = {}) =>
  igEnvelope([
    {
      ...between({ from: IG_ACCOUNT, to: IGSID, at: o.at }),
      message: { mid: o.mid ?? "aWdfECHO1", text: o.text ?? "Yes it is!", is_echo: true },
    },
  ]);

export const igStoryReply = () =>
  igDm({
    mid: "aWdfSTORY1",
    text: "Love this!",
    reply_to: {
      story: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1", id: "17900000000000001" },
    },
  });

export const igStoryMention = () =>
  igDm({
    mid: "aWdfMENTION1",
    text: undefined,
    attachments: [
      { type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2" } },
    ],
  });

export const igPhoto = () =>
  igDm({
    mid: "aWdfPHOTO1",
    text: undefined,
    attachments: [
      { type: "image", payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=3" } },
    ],
  });

/** A first message after a click on a Click-to-Instagram-Direct ad. */
export const igAdDm = () =>
  igDm({
    mid: "aWdfAD1",
    text: "I saw your ad",
    referral: {
      ref: "spring",
      ad_id: "120200000000000001",
      source: "ADS",
      type: "OPEN_THREAD",
      ads_context_data: { ad_title: "Spring batch", photo_url: "https://scontent.cdninstagram.com/p.jpg" },
    },
  });

export const igQuickReply = () =>
  igDm({ mid: "aWdfQR1", text: "Send me the guide", quick_reply: { payload: "step:2:guide" } });

export const igPostback = () =>
  igEnvelope([
    {
      ...between({ at: "2026-11-22T06:01:00Z" }),
      postback: { mid: "aWdfPB1", title: "Book a call", payload: "step:3:book" },
    },
  ]);

export const igReferral = () =>
  igEnvelope([{ ...between({}), referral: { ref: "bio", source: "SHORTLINK", type: "OPEN_THREAD" } }]);

export const igReaction = (action: "react" | "unreact" = "react") =>
  igEnvelope([
    {
      ...between({}),
      reaction: {
        mid: "aWdfECHO1",
        action,
        ...(action === "react" ? { reaction: "love", emoji: "❤️" } : {}),
      },
    },
  ]);

export const igSeen = () => igEnvelope([{ ...between({}), read: { mid: "aWdfECHO1" } }]);

export const igUnsend = () => igDm({ mid: "aWdfMID1", text: undefined, is_deleted: true });

/** A comment on one of the business's posts or reels. */
export const igComment = (
  o: {
    id?: string;
    text?: string;
    from?: string;
    username?: string;
    media?: Record<string, unknown>;
    field?: string;
    account?: string;
    time?: number;
    parent?: string;
  } = {},
) => ({
  object: "instagram",
  entry: [
    {
      id: o.account ?? IG_ACCOUNT,
      time: o.time ?? Math.floor(ms("2026-11-22T06:00:00Z") / 1000),
      changes: [
        {
          field: o.field ?? "comments",
          value: {
            from: { id: o.from ?? IGSID, username: o.username ?? "priya.fit" },
            media: o.media ?? { id: MEDIA_ID, media_product_type: "REELS" },
            id: o.id ?? COMMENT_ID,
            ...(o.parent ? { parent_id: o.parent } : {}),
            text: o.text ?? "GUIDE please",
          },
        },
      ],
    },
  ],
});

export const igAdComment = () =>
  igComment({
    id: "17990000000000002",
    media: { id: MEDIA_ID, media_product_type: "FEED", ad_id: "120200000000000002", ad_title: "Webinar" },
  });

/** Two accounts' deliveries in one batch: each belongs to its own LUME. */
export const igBatch = () => ({
  object: "instagram",
  entry: [
    igDm().entry[0]!,
    igDm({ mid: "aWdfB1", account: IG_ACCOUNT_B, from: "6512000000000002" }).entry[0]!,
  ],
});
