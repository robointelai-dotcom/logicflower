<?php

declare(strict_types=1);

require __DIR__.'/webhook.php';
require __DIR__.'/auth.php';
require __DIR__.'/app.php';

use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Facades\Auth;
use App\Models\User;

// Seamless SSO Provisioning Endpoint (Called by LeadFlower Backend)
Route::post('/sso/provision', function (Request $request) {
    if ($request->input('secret') !== 'leadflower-secret-123') {
        return response()->json(['error' => 'Unauthorized'], 401);
    }
    
    $user = User::firstOrCreate(
        ['email' => $request->input('email')],
        [
            'name' => $request->input('name'),
            'password' => bcrypt(\Illuminate\Support\Str::random(16))
        ]
    );

    // Generate a secure one-time login link valid for 5 minutes
    $loginUrl = URL::temporarySignedRoute('sso.login', now()->addMinutes(5), ['user' => $user->id]);

    return response()->json(['url' => $loginUrl]);
});

// The magic login link that the frontend will load
Route::get('/sso/login/{user}', function (User $user, Request $request) {
    if (! $request->hasValidSignature()) {
        abort(401, 'Invalid or expired login link.');
    }

    Auth::login($user);

    return redirect('/dashboard');
})->name('sso.login');
