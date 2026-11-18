mod common;
use common::*;
use rs_core::SyncState;

#[tokio::test]
async fn smoke_publish_and_receive() {
    let remote = Remote::new();
    let a = User::linked("Anna", &remote).await;
    let b = User::linked("Bruno", &remote).await;
    assert_synced(&a.status().await);

    a.write_ork("Razzo.ork", "uno");
    let st = a.status().await;
    assert_eq!(st.state, SyncState::LocalChanges);
    let st = a.publish("Primo razzo").await.unwrap();
    assert_synced(&st);
    assert_eq!(st.head_version, Some(1));
    assert_eq!(remote.tags(), vec!["v1"]);

    let st = b.sync().await;
    assert_synced(&st);
    assert_eq!(b.read("Razzo.ork"), ork("uno"));
    b.assert_clean();
}
