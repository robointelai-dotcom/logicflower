<?php
/**
 * Plugin Name: LogicFlower
 * Description: Puts your business details where search engines can read them, answers customers' questions on your site, and reports which enquiries turned into work.
 * Version: 1.0.0
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 *
 * WHAT THIS PLUGIN IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * It is a DELIVERY MECHANISM, not an editor. Everything is decided in
 * LogicFlower — where the jobs, the inbox and the reviews are — and this
 * renders the result. A plugin sitting in WordPress has no access to a
 * pipeline, so putting the thinking here would defeat the point.
 *
 * SECURITY POSTURE
 *
 * The site token can WRITE content and REPORT events. It can never READ
 * contacts, messages or deals. That is deliberate: if this customer's WordPress
 * is compromised — and small business sites are, regularly — nothing of THEIR
 * customers' data leaks, because none of it was ever here.
 *
 * The plugin also exposes no public endpoint of its own. It talks outward only.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('LOGICFLOWER_VERSION', '1.0.0');
define('LOGICFLOWER_OPTION_TOKEN', 'logicflower_site_token');
define('LOGICFLOWER_OPTION_BASE', 'logicflower_api_base');
define('LOGICFLOWER_OPTION_CACHE', 'logicflower_payload_cache');

/**
 * Fetch the schema and questions from LogicFlower.
 *
 * Cached for an hour. Without the cache every page view on the customer's site
 * becomes an outbound HTTP request, which makes their site slower than it was
 * before they installed something meant to help — and if we are down, their
 * site goes down with us.
 */
function logicflower_payload()
{
    $cached = get_transient(LOGICFLOWER_OPTION_CACHE);
    if ($cached !== false) {
        return $cached;
    }

    $token = get_option(LOGICFLOWER_OPTION_TOKEN, '');
    $base  = get_option(LOGICFLOWER_OPTION_BASE, '');
    if (empty($token) || empty($base)) {
        return null;
    }

    $response = wp_remote_get(
        trailingslashit($base) . 'api/v1/public/site/payload',
        array(
            'timeout' => 5,
            'headers' => array('X-LogicFlower-Site-Token' => $token),
        )
    );

    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
        /*
         * Cache the failure briefly.
         *
         * Otherwise an outage means every page view retries, the customer's
         * site slows to the timeout, and we have made their problem worse
         * while trying to help.
         */
        set_transient(LOGICFLOWER_OPTION_CACHE, null, 5 * MINUTE_IN_SECONDS);
        return null;
    }

    $payload = json_decode(wp_remote_retrieve_body($response), true);
    set_transient(LOGICFLOWER_OPTION_CACHE, $payload, HOUR_IN_SECONDS);
    return $payload;
}

/**
 * Do Yoast or Rank Math already emit business schema?
 *
 * Two LocalBusiness blocks on one page is a real conflict — search engines pick
 * one, unpredictably, and the operator cannot tell which. Detected so we can
 * defer rather than fight.
 */
function logicflower_other_schema_plugin()
{
    if (defined('WPSEO_VERSION')) {
        return 'Yoast SEO';
    }
    if (class_exists('RankMath')) {
        return 'Rank Math';
    }
    return null;
}

/**
 * Emit the business schema and the FAQ.
 *
 * Escaped through wp_json_encode with the flags that neutralise a closing
 * script tag inside a string — the one way a JSON-LD block can break out of
 * itself.
 */
function logicflower_render_schema()
{
    $payload = logicflower_payload();
    if (empty($payload['schema'])) {
        return;
    }

    if (logicflower_other_schema_plugin() && get_option('logicflower_defer_schema', '0') === '1') {
        return;
    }

    echo "\n<!-- LogicFlower -->\n";
    echo '<script type="application/ld+json">';
    echo wp_json_encode(
        $payload['schema'],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP
    );
    echo "</script>\n";
}
add_action('wp_head', 'logicflower_render_schema', 5);

/**
 * The FAQ block, as a shortcode: [logicflower_questions]
 *
 * A shortcode rather than an automatic injection, because where these belong on
 * a page is the site owner's decision and not ours.
 */
function logicflower_questions_shortcode()
{
    $payload = logicflower_payload();
    if (empty($payload['questions'])) {
        return '';
    }

    $output = '<div class="logicflower-questions">';
    foreach ($payload['questions'] as $entry) {
        if (empty($entry['question']) || empty($entry['answer'])) {
            continue;
        }
        $output .= '<details class="logicflower-question">';
        $output .= '<summary>' . esc_html($entry['question']) . '</summary>';
        $output .= '<p>' . esc_html($entry['answer']) . '</p>';
        $output .= '</details>';
    }
    $output .= '</div>';

    return $output;
}
add_shortcode('logicflower_questions', 'logicflower_questions_shortcode');

/**
 * Report a click on a phone number or a directions link.
 *
 * These are the events every other tool is blind to, and the reason LogicFlower
 * can attribute a job to a listing rather than stopping at the click.
 *
 * No personal data is collected. It records that an event happened and on which
 * page — never who did it.
 */
function logicflower_tracking_script()
{
    $token = get_option(LOGICFLOWER_OPTION_TOKEN, '');
    $base  = get_option(LOGICFLOWER_OPTION_BASE, '');
    if (empty($token) || empty($base)) {
        return;
    }
    ?>
<script>
(function () {
  var endpoint = <?php echo wp_json_encode(trailingslashit($base) . 'api/v1/public/site/event'); ?>;
  var token = <?php echo wp_json_encode($token); ?>;

  function report(kind, detail) {
    // sendBeacon so a click that navigates away still reports. A normal fetch
    // is cancelled the moment the page unloads, which is exactly when a phone
    // link fires.
    var body = JSON.stringify({ kind: kind, detail: detail, page: location.pathname, at: Date.now() });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint + '?t=' + encodeURIComponent(token), new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(endpoint, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-LogicFlower-Site-Token': token },
      body: body
    }).catch(function () { /* Never let our tracking break their page. */ });
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a');
    if (!link || !link.href) return;
    if (link.href.indexOf('tel:') === 0) return report('call', link.href.slice(4));
    if (/maps\.(google|apple)\./.test(link.href) || link.href.indexOf('geo:') === 0) return report('directions', null);
  }, true);

  document.addEventListener('submit', function (event) {
    if (event.target && event.target.tagName === 'FORM') report('form', event.target.getAttribute('id'));
  }, true);
})();
</script>
    <?php
}
add_action('wp_footer', 'logicflower_tracking_script');

/* -------------------------------------------------------------- admin page */

function logicflower_admin_menu()
{
    add_options_page('LogicFlower', 'LogicFlower', 'manage_options', 'logicflower', 'logicflower_settings_page');
}
add_action('admin_menu', 'logicflower_admin_menu');

function logicflower_settings_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }

    if (isset($_POST['logicflower_pairing_code']) && check_admin_referer('logicflower_pair')) {
        $code = sanitize_text_field(wp_unslash($_POST['logicflower_pairing_code']));
        $base = esc_url_raw(wp_unslash($_POST['logicflower_api_base'] ?? ''));
        $result = logicflower_pair($code, $base);
        if (is_wp_error($result)) {
            echo '<div class="notice notice-error"><p>' . esc_html($result->get_error_message()) . '</p></div>';
        } else {
            echo '<div class="notice notice-success"><p>Connected. Your business details are now on your site.</p></div>';
        }
    }

    $token = get_option(LOGICFLOWER_OPTION_TOKEN, '');
    $other = logicflower_other_schema_plugin();
    ?>
<div class="wrap">
  <h1>LogicFlower</h1>

  <?php if (empty($token)) : ?>
    <p>Enter the pairing code shown in LogicFlower under <strong>Getting found &rarr; My website</strong>.</p>
    <form method="post">
      <?php wp_nonce_field('logicflower_pair'); ?>
      <table class="form-table">
        <tr>
          <th><label for="logicflower_api_base">LogicFlower address</label></th>
          <td><input name="logicflower_api_base" id="logicflower_api_base" type="url" class="regular-text"
                     value="<?php echo esc_attr(get_option(LOGICFLOWER_OPTION_BASE, '')); ?>" required></td>
        </tr>
        <tr>
          <th><label for="logicflower_pairing_code">Pairing code</label></th>
          <td><input name="logicflower_pairing_code" id="logicflower_pairing_code" type="text"
                     class="regular-text" placeholder="K4M2-9XPT" required></td>
        </tr>
      </table>
      <?php submit_button('Connect'); ?>
    </form>
  <?php else : ?>
    <p><strong>Connected.</strong> Your business details and questions are being published on this site.</p>
    <p>Add <code>[logicflower_questions]</code> to any page to show your answered questions.</p>

    <?php if ($other) : ?>
      <div class="notice notice-warning inline">
        <p>
          <strong><?php echo esc_html($other); ?> is also installed</strong> and publishes its own business
          details. Two sets on one page confuse search engines, which pick one unpredictably.
        </p>
        <form method="post" action="options.php">
          <?php settings_fields('logicflower_options'); ?>
          <label>
            <input type="checkbox" name="logicflower_defer_schema" value="1"
                   <?php checked(get_option('logicflower_defer_schema', '0'), '1'); ?>>
            Let <?php echo esc_html($other); ?> handle the business details instead
          </label>
          <?php submit_button('Save', 'secondary'); ?>
        </form>
      </div>
    <?php endif; ?>

    <form method="post">
      <?php wp_nonce_field('logicflower_disconnect'); ?>
      <?php submit_button('Disconnect', 'delete', 'logicflower_disconnect', false); ?>
    </form>
  <?php endif; ?>
</div>
    <?php
}

function logicflower_register_settings()
{
    register_setting('logicflower_options', 'logicflower_defer_schema');
}
add_action('admin_init', 'logicflower_register_settings');

/**
 * Exchange a short pairing code for a site token.
 *
 * The code is four characters, a dash, four — readable over the phone to
 * whoever built the site. An API key would be forty characters of base64 that
 * gets truncated when pasted.
 */
function logicflower_pair($code, $base)
{
    if (empty($base)) {
        return new WP_Error('logicflower_base', 'Enter the LogicFlower address first.');
    }

    $response = wp_remote_post(
        trailingslashit($base) . 'api/v1/public/site/pair',
        array(
            'timeout' => 10,
            'headers' => array('Content-Type' => 'application/json'),
            'body'    => wp_json_encode(array(
                'code'    => $code,
                'siteUrl' => home_url(),
                'version' => LOGICFLOWER_VERSION,
            )),
        )
    );

    if (is_wp_error($response)) {
        return new WP_Error('logicflower_network', 'Could not reach LogicFlower. Check the address and try again.');
    }
    if (wp_remote_retrieve_response_code($response) !== 200) {
        return new WP_Error('logicflower_code', 'That pairing code was not accepted. Codes expire after fifteen minutes — generate a new one.');
    }

    $body = json_decode(wp_remote_retrieve_body($response), true);
    if (empty($body['siteToken'])) {
        return new WP_Error('logicflower_token', 'LogicFlower did not return a token. Try generating a new code.');
    }

    update_option(LOGICFLOWER_OPTION_TOKEN, sanitize_text_field($body['siteToken']));
    update_option(LOGICFLOWER_OPTION_BASE, esc_url_raw($base));
    delete_transient(LOGICFLOWER_OPTION_CACHE);

    return true;
}

/** Remove the token on uninstall. Leaving a live credential behind is careless. */
function logicflower_deactivate()
{
    delete_transient(LOGICFLOWER_OPTION_CACHE);
}
register_deactivation_hook(__FILE__, 'logicflower_deactivate');
