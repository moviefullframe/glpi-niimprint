<?php

use Glpi\Plugin\Hooks;

require_once __DIR__ . '/inc/settings.class.php';

function plugin_init_niimprint(): void
{
    global $PLUGIN_HOOKS;

    $PLUGIN_HOOKS[Hooks::MENU_TOADD]['niimprint']['tools'] = PluginNiimprintSettings::class;
    if (Session::haveRight(Config::$rightname, UPDATE)) {
        $PLUGIN_HOOKS[Hooks::CONFIG_PAGE]['niimprint'] = 'front/settings.php';
    }
    $PLUGIN_HOOKS[Hooks::ADD_JAVASCRIPT_MODULE]['niimprint'] = [
        'print.js',
    ];
    $PLUGIN_HOOKS[Hooks::POST_SHOW_ITEM]['niimprint'] = 'plugin_niimprint_render_label_data';
    $PLUGIN_HOOKS[Hooks::POST_SHOW_TAB]['niimprint'] = 'plugin_niimprint_render_label_data';
}

function plugin_version_niimprint(): array
{
    return [
        'name' => 'NIIMBOT QR Print',
        'version' => '0.8.0',
        'requirements' => [
            'glpi' => ['min' => '12.0.2', 'max' => '12.0.3'],
        ],
    ];
}
