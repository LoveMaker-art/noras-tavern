// Local inspection only. The existing importer remains responsible for validity
// and persistence; selecting a file never uploads it or executes its content.
export async function readCardImportPreview(file) {
    if (!file || !file.size || file.size > 32 * 1024 * 1024) throw new Error('请选择不超过 32 MB 的角色卡。');
    const format = file.name.split('.').pop().toLowerCase();
    const preview = { name: file.name, description: '', image: null, format };
    if (format === 'png') {
        preview.image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('图片预览失败'));
            reader.onabort = () => reject(new Error('图片预览已取消'));
            reader.readAsDataURL(new Blob([file], { type: 'image/png' }));
        });
    } else if (format === 'json') {
        const value = JSON.parse(await file.text());
        const card = value?.data && typeof value.data === 'object' ? value.data : value;
        if (typeof card?.name === 'string' && card.name.trim()) preview.name = card.name.slice(0, 200);
        if (typeof card?.description === 'string') preview.description = card.description.slice(0, 240);
    }
    return preview;
}
