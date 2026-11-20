<?php

function plugin_niimprint_install(): bool
{
    return true;
}

function plugin_niimprint_uninstall(): bool
{
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

    $barcode = (new BarcodeManager())->generateQRCode($item);
    if (!$barcode) {
        return;
    }

    $year = '';
    if (Session::haveRight(Infocom::$rightname, READ)) {
        $financialInfo = new Infocom();
        if (
            $financialInfo->getFromDBforDevice($item::class, $item->getID())
            && preg_match('/^([1-9][0-9]{3})-[0-9]{2}-[0-9]{2}$/D', $financialInfo->fields['buy_date'] ?? '', $match)
        ) {
            $year = $match[1];
        }
    }

    printf(
        '<span hidden data-niimprint-item="%d" data-inventory-number="%s" data-year="%s" data-qr-modules="%s"></span>',
        $item->getID(),
        htmlspecialchars($item->fields['otherserial'] ?? '', ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'),
        $year,
        htmlspecialchars(str_replace("\n", '', trim($barcode->getGrid())), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')
    );
}
