<?php
// Keep generated passwords out of process arguments and command output.
$secret = $argv[1] ?? '';
if (!in_array($secret, ['employee-one', 'employee-two', 'outsider'], true)) {
    fwrite(STDERR, "Unknown pilot account\n");
    exit(2);
}
putenv('OC_PASS=' . trim(file_get_contents('/run/secrets/' . $secret)));
$argv = array_merge(['/var/www/html/occ'], array_slice($argv, 2));
$argc = count($argv);
$_SERVER['argv'] = $argv;
$_SERVER['argc'] = $argc;
chdir('/var/www/html');
require '/var/www/html/occ';
