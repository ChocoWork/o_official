// GET: カート情報取得（一時的なテスト用実装）
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    
    // 一時的にテストデータを返す
    const testData = [
      {
        id: 1,
        user_id: "test-user-id",
        item_id: 1,
        name: "LAYERED PANTS",
        price: 41800,
        image: "https://placehold.co/600x800/ffffff/000000?text=LAYERED+PANTS",
        quantity: 1,
        category: "pants",
        color: "black",
        size: "M",
        inStock: true,
        created_at: new Date().toISOString()
      }
    ];

    return NextResponse.json(testData);
  } catch (error) {
    console.error('Server Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}