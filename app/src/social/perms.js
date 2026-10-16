// Who sees the "Remove from the Recharge Library" button: the uploader, and admins on everyone's items.
export const canRemoveUpload = (mine, admin) => !!(mine || admin);
