<?php

use Com\Tecnick\Barcode\Barcode;

require_once __DIR__ . '/inc/settings.class.php';

function plugin_niimprint_install(): bool
{
    return true;
}

function plugin_niimprint_uninstall(): bool
{
    PluginNiimprintSettings::remove();
    return true;
}

function plugin_niimprint_render_label_data(array $params): void
{
    global $CFG_GLPI;

    $item = $params['item'] ?? null;
    if (
        !$item instanceof CommonDBTM
        || $item->isNewItem()
        || !in_array($item::class, $CFG_GLPI['asset_types'], true)
        || !$item->can($item->getID(), READ)
    ) {
        return;
    }

    $settings = PluginNiimprintSettings::load();
    $fields = $settings['fields'];
    $inventory = (string) ($item->fields['otherserial'] ?? '');
    $barcode = null;
    $error = '';
    if ($settings['qr'] === 'inventory') {
        if (trim($inventory) === '') {
            $error = 'Для печати заполните инвентарный номер в карточке.';
        } elseif (strlen($inventory) > 512) {
            $error = 'Инвентарный номер слишком длинный для QR-кода этой этикетки.';
        } else {
            $barcode = (new Barcode())->getBarcodeObj('QRCODE,H', $inventory);
        }
    } else {
        $barcode = (new BarcodeManager())->generateQRCode($item);
    }

    $year = '';
    if (in_array('year', $fields, true) && Session::haveRight(Infocom::$rightname, READ)) {
        $financialInfo = new Infocom();
        if (
            $financialInfo->getFromDBforDevice($item::class, $item->getID())
            && preg_match('/^([1-9][0-9]{3})-[0-9]{2}-[0-9]{2}$/D', $financialInfo->fields['buy_date'] ?? '', $match)
        ) {
            $year = $match[1];
        }
    }

    $attributes = [
        'niimprint-item' => $item->getID(),
        'niimprint-url' => $item::getFormURLWithID($item->getID()),
        'inventory-number' => in_array('inventory', $fields, true) ? $inventory : '',
        'asset-name' => in_array('name', $fields, true) ? ($item->fields['name'] ?? '') : '',
        'serial' => in_array('serial', $fields, true) ? ($item->fields['serial'] ?? '') : '',
        'year' => $year,
        'size' => $settings['size'],
        'print-error' => $error,
        'qr-modules' => $barcode ? str_replace("\n", '', trim($barcode->getGrid())) : '',
    ];
    echo '<span hidden';
    foreach ($attributes as $key => $value) {
        printf(' data-%s="%s"', $key, htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'));
    }
    echo '></span>';
}
