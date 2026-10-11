# Example feature: Twitter-style landing page

Build a landing page for a simple Twitter-style app in the application project
receiving this request. Use its existing framework and project conventions.

## Functionality

- Show a timeline with representative sample posts and replies.
- Provide a text composer to publish a new post using a demo author.
- Add published posts to the top of the timeline without a full page reload.
- Allow a text reply directly to a post and display it beneath that post.
- Support exactly one reply level: replies cannot receive further replies.
- Reject empty or whitespace-only posts and replies with clear feedback.
- Keep posts and replies in local demo state; no login or external service is required.

## Design

- Use Tailwind CSS for a clean, simple social feed layout.
- Make the page usable on mobile and desktop without horizontal overflow.
- Include a visible light/dark mode toggle that changes the entire page.
- Keep text, inputs, cards, borders and buttons readable in both themes.
- Give controls accessible labels, keyboard access and visible focus states.

## Acceptance criteria

- The landing page loads with sample content and a working post composer.
- Publishing a valid post immediately adds it to the timeline.
- Publishing a valid reply shows it under the correct parent post.
- There is no action to reply to a reply, and no nested reply thread is created.
- Empty submissions do not create content and show useful feedback.
- Switching themes updates the whole page while preserving the current demo content.
- Existing relevant checks pass, and the main interactions are verified.

Keep this feature limited to the landing page, posts, one-level replies and themes.
Authentication, profiles, following, likes, reposts and production persistence are outside this scope.
