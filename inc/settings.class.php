<?php

final class PluginNiimprintSettings
{
    public const PAGE = '/plugins/niimprint/front/settings.php';
    public const TITLE = 'NIIMBOT QR Print';
    public const SIZES = ['12x40' => '12 × 40 мм', '12x22' => '12 × 22 мм', '15x30' => '15 × 30 мм'];
    public const FIELDS = [
        'name' => 'Наименование объекта',
        'inventory' => 'Инвентарный номер',
        'serial' => 'Серийный номер',
        'year' => 'Год покупки',
    ];
    public const DEFAULTS = ['qr' => 'url', 'size' => '12x40', 'fields' => ['inventory', 'year']];
    private const CONTEXT = 'plugin:niimprint';

    public static function getMenuContent()
    {
        if (!Session::haveRight(Config::$rightname, UPDATE)) {
            return false;
        }
        return ['title' => self::TITLE, 'page' => self::PAGE, 'icon' => 'ti ti-printer'];
    }

    public static function validate(array $input): array
    {
        $qr = $input['qr'] ?? null;
        $size = $input['size'] ?? null;
        $fields = $input['fields'] ?? [];
        if (!in_array($qr, ['url', 'inventory'], true)
            || !is_string($size) || !isset(self::SIZES[$size]) || !is_array($fields)) {
            throw new InvalidArgumentException('Проверьте содержимое QR-кода и размер этикетки.');
        }
        foreach ($fields as $field) {
            if (!is_string($field) || !isset(self::FIELDS[$field])) {
                throw new InvalidArgumentException('Выбрано неизвестное поле этикетки.');
            }
        }
        return ['qr' => $qr, 'size' => $size, 'fields' => array_values(array_intersect(array_keys(self::FIELDS), $fields))];
    }

    public static function load(): array
    {
        $value = Config::getConfigurationValue(self::CONTEXT, 'label');
        return $value === null ? self::DEFAULTS : self::validate(json_decode($value, true, flags: JSON_THROW_ON_ERROR));
    }

    public static function save(array $input): void
    {
        $settings = self::validate($input);
        Config::setConfigurationValues(self::CONTEXT, ['label' => json_encode($settings, JSON_THROW_ON_ERROR)]);
    }

    public static function remove(): void
    {
        Config::deleteConfigurationValues(self::CONTEXT, ['label']);
    }
}
