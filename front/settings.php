<?php

require_once dirname(__DIR__) . '/inc/settings.class.php';

Session::checkRight(Config::$rightname, UPDATE);
if (!Plugin::isPluginActive('niimprint')) {
    http_response_code(404);
    return;
}

$url = Html::getPrefixedUrl(PluginNiimprintSettings::PAGE);
$error = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        PluginNiimprintSettings::save($_POST);
        Session::addMessageAfterRedirect('Настройки этикетки сохранены.');
        Html::redirect($url, 303);
    } catch (InvalidArgumentException $e) {
        $error = $e->getMessage();
        http_response_code(422);
    }
}
$settings = PluginNiimprintSettings::load();
Html::header(PluginNiimprintSettings::TITLE, $url, 'tools', PluginNiimprintSettings::class);
?>
<div class="container-xl">
  <form method="post" action="<?= htmlescape($url) ?>" class="card">
    <div class="card-body">
      <h2 class="card-title">Настройки этикетки NIIMBOT D11_H</h2>
      <p>Эти настройки действуют для всех пользователей плагина.</p>
      <?php if ($error !== null): ?>
        <div class="alert alert-danger" role="alert"><?= htmlescape($error) ?></div>
      <?php endif; ?>
      <div class="mb-3">
        <label for="niimprint-qr" class="form-label">Содержимое QR-кода</label>
        <select name="qr" id="niimprint-qr" class="form-select">
          <?php foreach (['url' => 'Полная ссылка на карточку GLPI', 'inventory' => 'Инвентарный номер'] as $key => $title): ?>
            <option value="<?= $key ?>" <?= $key === $settings['qr'] ? 'selected' : '' ?>><?= $title ?></option>
          <?php endforeach; ?>
        </select>
        <div class="form-hint">При выборе инвентарного номера карточка должна содержать заполненный номер.</div>
      </div>
      <fieldset class="mb-3"><legend class="form-label">Текст рядом с QR-кодом</legend>
        <?php foreach (PluginNiimprintSettings::FIELDS as $key => $title): ?>
          <label class="form-check"><input class="form-check-input" type="checkbox" name="fields[]" value="<?= $key ?>" <?= in_array($key, $settings['fields'], true) ? 'checked' : '' ?>>
            <span class="form-check-label"><?= $title ?></span></label>
        <?php endforeach; ?>
        <div class="form-hint">Снимите все отметки для печати одного QR-кода. Год покупки виден только при наличии доступа к финансовым данным.</div>
      </fieldset>
      <label for="niimprint-size" class="form-label">Размер установленной этикетки</label>
      <select name="size" id="niimprint-size" class="form-select">
        <?php foreach (PluginNiimprintSettings::SIZES as $key => $title): ?>
          <option value="<?= $key ?>" <?= $key === $settings['size'] ? 'selected' : '' ?>><?= $title ?></option>
        <?php endforeach; ?>
      </select>
    </div>
    <div class="card-footer"><button type="submit" class="btn btn-primary">Сохранить</button></div>
  </form>
</div>
<?php Html::footer(); ?>
