<?php

use Glpi\Plugin\Hooks;

function plugin_init_niimprint(): void
{
    global $PLUGIN_HOOKS;

    $PLUGIN_HOOKS[Hooks::ADD_JAVASCRIPT]['niimprint'] = [
        'vendor/niimbot.js',
        'print.js',
    ];
    $PLUGIN_HOOKS[Hooks::POST_SHOW_ITEM]['niimprint'] = 'plugin_niimprint_render_label_data';
    $PLUGIN_HOOKS[Hooks::POST_SHOW_TAB]['niimprint'] = 'plugin_niimprint_render_label_data';
}

function plugin_version_niimprint(): array
{
    return [
        'name' => 'NIIMBOT QR Print',
        'version' => '0.6.7',
        'requirements' => [
            'glpi' => ['min' => '11.0.0', 'max' => '12.0.99'],
        ],
    ];
}
