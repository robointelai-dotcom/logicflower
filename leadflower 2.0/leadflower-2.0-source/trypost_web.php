<?php

declare(strict_types=1);

require __DIR__.'/webhook.php';
require __DIR__.'/auth.php';
require __DIR__.'/app.php';

use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\RateLimiter;
use App\Models\User;

/*
 * SSO provisioning, called by the LeadFlower backend.
 *
 * Three things were wrong here.
 *
 * 1. The shared secret was a hardcoded literal, committed to a public
 *    repository and therefore compromised. It now comes from the environment
 *    and the route refuses to serve at all if it is unset, rather than falling
 *    back to a known value. Rotate the old one before deploying this.
 *
 * 2. The comparison used !==, which returns as soon as two bytes differ and so
 *    leaks the secret a byte at a time to anyone willing to measure. hash_equals
 *    compares in constant time.
 *
 * 3. User::firstOrCreate keyed on email ALONE. LeadFlower is multi-tenant; the
 *    same person may own a workspace and be an operator in a client's. Both got
 *    the same Trypost account, which means the same connected Facebook and
 *    LinkedIn pages — one tenant publishing under another tenant's identity.
 *    The workspace key now forms part of the account identity.
 */
Route::post('/sso/provision', function (Request $request) {
    $expected = (string) env('LEADFLOWER_SSO_SECRET', '');
    if ($expected === '' || strlen($expected) < 32) {
        // Fail closed. An unconfigured deployment must not authenticate anyone.
        return response()->json(['error' => 'SSO is not configured'], 503);
    }

    $presented = (string) $request->input('secret', '');
    if (! hash_equals($expected, $presented)) {
        return response()->json(['error' => 'Unauthorized'], 401);
    }

    $email = trim((string) $request->input('email', ''));
    $workspaceKey = trim((string) $request->input('workspaceKey', ''));
    if ($email === '' || $workspaceKey === '') {
        return response()->json(['error' => 'email and workspaceKey are required'], 422);
    }

    // Brute-force protection on the workspace, independent of the caller's IP.
    $throttleKey = 'sso-provision:'.sha1($workspaceKey.'|'.$email);
    if (RateLimiter::tooManyAttempts($throttleKey, 30)) {
        return response()->json(['error' => 'Too many requests'], 429);
    }
    RateLimiter::hit($throttleKey, 300);

    // Identity is (workspace, email), never email alone.
    $user = User::firstOrCreate(
        ['workspace_key' => $workspaceKey, 'email' => $email],
        [
            'name' => (string) $request->input('name', 'User'),
            'password' => bcrypt(\Illuminate\Support\Str::random(40)),
        ]
    );

    // A secure one-time login link, valid for five minutes.
    $loginUrl = URL::temporarySignedRoute('sso.login', now()->addMinutes(5), ['user' => $user->id]);

    return response()->json(['url' => $loginUrl]);
});

// The magic login link the frontend loads. Single use: the signature is
// validated and the link is burned so a leaked URL in a referrer header or a
// browser history cannot be replayed within its five-minute window.
Route::get('/sso/login/{user}', function (User $user, Request $request) {
    if (! $request->hasValidSignature()) {
        abort(401, 'Invalid or expired login link.');
    }

    $burnKey = 'sso-login-used:'.sha1((string) $request->fullUrl());
    if (cache()->has($burnKey)) {
        abort(401, 'This login link has already been used.');
    }
    cache()->put($burnKey, true, now()->addMinutes(10));

    Auth::login($user);

    return redirect('/dashboard');
})->name('sso.login');
