# Web interface review checklist

Repository-maintained checks for the interaction, responsive layout, and accessibility review.
This is a local checklist, not a claim that the current upstream Vercel rules were fetched.

- Use semantic buttons for actions and links for navigation; give controls accessible names.
- Support keyboard navigation, visible focus, sensible tab order, and focus return from dialogs.
- Label form inputs, associate errors with the affected field, and preserve useful input on failure.
- Check text and control contrast using actual color values; do not convey state by color alone.
- Preserve readable content and reachable controls when zooming, resizing, or using large text.
- Make touch targets and spacing comfortable; support the project's iPad layouts and safe areas.
- Respect reduced motion and avoid animation that prevents task completion.
- Expose loading, success, and error states; guard duplicate submissions and provide recovery.
- Give dialogs an accessible title and keyboard dismissal, and explain destructive actions.
- Reserve image/media dimensions, provide appropriate alternate text, and avoid layout shifts.
- Keep headings, labels, and copy consistent with the action and the current page hierarchy.
- Report evidence from the supplied code or view; identify checks requiring runtime measurement.
