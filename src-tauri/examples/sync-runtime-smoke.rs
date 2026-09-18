//! Exercise the real dependency installer in an isolated directory, without a vault.
#[allow(dead_code)]
#[path = "../src/sync_runtime.rs"]
mod sync_runtime;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 3 && args[0] == "--check-provider" {
        let temp = tempfile::Builder::new()
            .prefix("Nephrite login test ")
            .tempdir()
            .unwrap();
        check_private_arguments(
            &sync_runtime::Installation {
                node: args[1].clone().into(),
                cli: args[2].clone().into(),
            },
            temp.path(),
        );
        println!("PASS: real ob command parsing and private credential transport");
        return;
    }
    let directory = tempfile::Builder::new()
        .prefix("Nephrite runtime test ")
        .tempdir()
        .expect("temporary installation directory");
    let install = sync_runtime::install(directory.path(), &[]).expect("clean installation");
    assert!(install
        .command()
        .arg("--version")
        .status()
        .unwrap()
        .success());
    let again = sync_runtime::install(directory.path(), &[]).expect("repeat installation");
    assert_eq!(install.node, again.node);
    assert_eq!(install.cli, again.cli);
    assert!(again
        .command()
        .arg("--help")
        .output()
        .unwrap()
        .status
        .success());
    std::fs::remove_file(&again.cli).unwrap();
    let repaired =
        sync_runtime::install(directory.path(), &[]).expect("repair incomplete provider");
    assert_eq!(repaired.node, install.node);
    assert!(repaired
        .command()
        .arg("--version")
        .status()
        .unwrap()
        .success());
    check_private_arguments(&repaired, directory.path());
    println!(
        "PASS: clean runtime + provider installation, launch, repeat installation, repair, and private login arguments"
    );
}

fn check_private_arguments(provider: &sync_runtime::Installation, directory: &std::path::Path) {
    use std::io::Write;
    let mut setup = sync_runtime::setup_args(
        "test-vault",
        "vault path",
        "test device",
        "  encryption \"test\"  ",
    );
    setup.push("--help");
    for args in [
        setup,
        vec!["--version"],
        vec!["login", "--help"],
        vec!["sync-list-remote", "--help"],
    ] {
        let mut command = provider.private_command();
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(&args).unwrap().as_bytes())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "real provider rejected {args:?}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        if args.contains(&"login") {
            assert!(String::from_utf8_lossy(&result.stdout).contains("--password"));
        }
    }
    // Test private argument transport without contacting an authentication service.
    let fixture = directory.join("login fixture.mjs");
    std::fs::write(&fixture, r#"
import assert from 'node:assert/strict';
if (process.argv[2] === 'sync-setup') {
  assert.deepEqual(process.argv.slice(2), ['sync-setup', '--vault', 'test-vault', '--path', 'vault path', '--device-name', 'test device', '--config-dir', '.obsidian', '--password', '  encryption "test"  ', '--json']);
} else {
  assert.deepEqual(process.argv.slice(2), ['login', '--email', 'test@example.invalid', '--password', 'test password "with quotes"', '--mfa', '123456']);
}
console.log('Logged in as Test (test@example.invalid)');
"#).unwrap();
    let fixture = sync_runtime::Installation {
        node: provider.node.clone(),
        cli: fixture,
    };
    for args in [
        vec![
            "login",
            "--email",
            "test@example.invalid",
            "--password",
            "test password \"with quotes\"",
            "--mfa",
            "123456",
        ],
        sync_runtime::setup_args(
            "test-vault",
            "vault path",
            "test device",
            "  encryption \"test\"  ",
        ),
    ] {
        let mut command = fixture.private_command();
        assert!(!format!("{command:?}").contains("test password"));
        assert!(!format!("{command:?}").contains("encryption"));
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(&args).unwrap().as_bytes())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).starts_with("Logged in as "));
    }
}
