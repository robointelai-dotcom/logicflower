=== LogicFlower ===
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Puts your business details where search engines can read them, answers your
customers' questions on your site, and reports which enquiries turned into work.

== What it does ==

* Publishes your business details — address, hours, service area, registrations —
  in the format search engines read.
* Shows the questions customers actually ask you, with your answers, as an FAQ
  block. Add `[logicflower_questions]` to any page.
* Reports when somebody taps your phone number, asks for directions, or submits
  a form, so LogicFlower can tell you which enquiries became work.

== What it does NOT do ==

This plugin holds no customer data. It can write content to this site and report
that an event happened. **It cannot read your contacts, your messages or your
deals** — those never leave LogicFlower.

That is deliberate. If this website is ever compromised, nothing about your
customers leaks through this plugin, because none of it was ever stored here.

The plugin also opens no public endpoint of its own. It only talks outward.

== Installing ==

1. In LogicFlower, open **Getting found → My website** and note the pairing code.
2. Here, go to **Plugins → Add New → Upload Plugin** and choose the zip.
3. Activate it, then open **Settings → LogicFlower** and paste the code.

Pairing codes expire after fifteen minutes. Generate a new one if it lapses.

== If you already use Yoast or Rank Math ==

Both publish their own business details. Two sets on one page confuse search
engines, which pick one unpredictably. The plugin detects this and offers to let
the other one handle it.

== Updates ==

This plugin is distributed directly rather than through the WordPress directory,
so it does not update automatically. LogicFlower tells you when a newer version
is available.
