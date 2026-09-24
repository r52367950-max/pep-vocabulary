# Reading artwork

> 版本记录：本文的分工、过程与验证限制只描述该次更新；日常开发见 [开发说明](DEVELOPMENT.md)。

Generated on 2026-09-15 using the built-in ImageGen tool. Original raster output is 1536 × 1024; delivery uses WebP quality 91, method 6. Encoding only: no crop, retouching, resize, or pixel edits.

| Asset | Meaning and use |
| --- | --- |
| `public/images/reading-conversation.webp` | Precise white and translucent coral paper sheets, expressing shared reading and communication. Main cover for “A Place to Begin”; also reusable by the app’s dictation entry. |
| `public/images/reading-nature.webp` | Two living bean seedlings in clear glass. Feature art for “A Small Question”, directly matching its observation/experiment topic. |

The other four articles use a compact text list. The seedling image is deliberately not assigned to unrelated travel or technology articles. Images are decorative; adjacent live headings carry article names, avoiding baked-in text and duplicate screen-reader announcements. CSS adapts the display framing at narrow widths.

## Conversation prompt

Use case: stylized-concept. Asset type: premium English-reading app content cover. Create a refined, photorealistic 3D studio still life about expressing an idea through paper: three beautifully curved, unprinted white paper sheets, like a few loose pages caught at the moment they open into a conversation, one slender semi-translucent pale coral sheet between them. The paper has precise knife-cut edges and subtle realistic thickness, visibly fine clean paper material, elegant restrained curves, no crumpling. One coherent sculpture, no other objects. Wide landscape composition, sculpture placed in the right 55% of the frame, left 40% calm empty pale blush space for live interface typography. Seamless extremely pale blush studio floor and background (#f6ece9), subtly warm neutral softbox lighting from upper left, delicate physically realistic contact shadows. High-end industrial product photography / premium 3D campaign image, 85mm lens, precise clean material detail, calm sculptural silhouette, generous negative space. No text or letters, no logos, no UI, no borders, no scattered decorative objects, no particles or grain, no room, no people. Landscape 1536 by 1024.

## Nature prompt

Use case: stylized-concept. Asset type: premium English-reading app content cover, matching a quiet studio paper-art campaign. Create a refined, photorealistic 3D studio still life for a short article about observing bean-plant growth: two tiny living bean seedlings with natural luminous green leaves, placed in two simple immaculate clear glass vessels, each with a small amount of clean water and visible delicate roots. A single cohesive close composition, one seedling slightly taller than the other. The vessels are thin-walled cylindrical laboratory glass with no markings, no caps, no decorative bevels. Right-center composition, subjects occupy right 60%, generous clean empty space at left. Seamless very pale cool green studio floor and background (#eaf1e8), soft neutral softbox lighting from upper left and long delicate contact shadows. Exact premium industrial product photography quality, physically believable glass, quiet translucent material, realistic botanical structure, fine precise details without visual noise. No soil piles, no extra props, no text or letters, no numbers, no logos, no UI, no frame, no particles or grain, no room, no people. Landscape 1536 by 1024.

## Implementation

Import `app/reading-surfaces.css` after shared controls. All selectors use `reading-shelf-` or `reader-` prefixes and consume existing app color variables. The article column is capped at 680px. No study, scheduling, vocabulary, or storage engine was changed.
